#[cfg(not(feature = "std"))]
use alloc::{format, string::String, vec::Vec};
use core::marker::PhantomData;
use core::ops::Range;

use crate::field::extension::algebra::ExtensionAlgebra;
use crate::field::extension::{Extendable, FieldExtension, OEF};
use crate::field::interpolation::barycentric_weights;
use crate::field::types::Field;
use crate::gates::gate::VerificationGate;
use crate::gates::util::StridedConstraintConsumer;
use crate::hash::hash_types::RichField;
use crate::plonk::circuit_data::CommonCircuitData;
use crate::plonk::vars::{EvaluationVars, EvaluationVarsBase};
use crate::util::serialization::{Buffer, IoResult, Read, Write};

/// One of the instantiations of `InterpolationGate`: allows constraints of variable
/// degree, up to `1<<subgroup_bits`.
///
/// This gate has as routed wires
/// - the coset shift from subgroup H
/// - the values that the interpolated polynomial takes on the coset
/// - the evaluation point
///
/// The evaluation strategy is based on the observation that if $P(X)$ is the interpolant of some
/// values over a coset and $P'(X)$ is the interpolant of those values over the subgroup, then
/// $P(X) = P'(X \cdot \mathrm{shift}^{-1})$. Interpolating $P'(X)$ is preferable because when subgroup is fixed
/// then so are the Barycentric weights and both can be hardcoded into the constraint polynomials.
///
/// A full interpolation of N values corresponds to the evaluation of a degree-N polynomial. This
/// gate can however be configured with a bounded degree of at least 2 by introducing more
/// non-routed wires. Let $x[]$ be the domain points, $v[]$ be the values, $w[]$ be the Barycentric
/// weights and $z$ be the evaluation point. Define the sequences
///
/// $p\[0\] = 1,$
///
/// $p\[i\] = p[i - 1] \cdot (z - x[i - 1]),$
///
/// $e\[0\] = 0,$
///
/// $e\[i\] = e[i - 1] ] \cdot (z - x[i - 1]) + w[i - 1] \cdot v[i - 1] \cdot p[i - 1]$
///
/// Then $e\[N\]$ is the final interpolated value. The non-routed wires hold every $(d - 1)$'th
/// intermediate value of $p$ and $e$, starting at $p\[d\]$ and $e\[d\]$, where $d$ is the gate degree.
#[derive(Clone, Debug, Default)]
pub struct CosetInterpolationGate<F: RichField + Extendable<D>, const D: usize> {
    pub subgroup_bits: usize,
    pub degree: usize,
    pub barycentric_weights: Vec<F>,
    _phantom: PhantomData<F>,
}

impl<F: RichField + Extendable<D>, const D: usize> CosetInterpolationGate<F, D> {
    pub fn new(subgroup_bits: usize) -> Self {
        Self::with_max_degree(subgroup_bits, 1 << subgroup_bits)
    }

    pub(crate) fn with_max_degree(subgroup_bits: usize, max_degree: usize) -> Self {
        assert!(max_degree > 1, "need at least quadratic constraints");

        let n_points = 1 << subgroup_bits;

        // Number of intermediate values required to compute interpolation with degree bound
        let n_intermediates = (n_points - 2) / (max_degree - 1);

        // Find minimum degree such that (n_points - 2) / (degree - 1) < n_intermediates + 1
        // Minimizing the degree this way allows the gate to be in a larger selector group
        let degree = (n_points - 2) / (n_intermediates + 1) + 2;

        let barycentric_weights = barycentric_weights(
            &F::two_adic_subgroup(subgroup_bits)
                .into_iter()
                .map(|x| (x, F::ZERO))
                .collect::<Vec<_>>(),
        );

        Self {
            subgroup_bits,
            degree,
            barycentric_weights,
            _phantom: PhantomData,
        }
    }

    const fn num_points(&self) -> usize {
        1 << self.subgroup_bits
    }

    /// Wire index of the coset shift.
    pub(crate) const fn wire_shift(&self) -> usize {
        0
    }

    const fn start_values(&self) -> usize {
        1
    }

    /// Wire indices of the `i`th interpolant value.
    pub(crate) fn wires_value(&self, i: usize) -> Range<usize> {
        debug_assert!(i < self.num_points());
        let start = self.start_values() + i * D;
        start..start + D
    }

    const fn start_evaluation_point(&self) -> usize {
        self.start_values() + self.num_points() * D
    }

    /// Wire indices of the point to evaluate the interpolant at.
    pub(crate) const fn wires_evaluation_point(&self) -> Range<usize> {
        let start = self.start_evaluation_point();
        start..start + D
    }

    const fn start_evaluation_value(&self) -> usize {
        self.start_evaluation_point() + D
    }

    /// Wire indices of the interpolated value.
    pub(crate) const fn wires_evaluation_value(&self) -> Range<usize> {
        let start = self.start_evaluation_value();
        start..start + D
    }

    const fn start_intermediates(&self) -> usize {
        self.start_evaluation_value() + D
    }

    pub const fn num_routed_wires(&self) -> usize {
        self.start_intermediates()
    }

    const fn num_intermediates(&self) -> usize {
        (self.num_points() - 2) / (self.degree - 1)
    }

    /// The wires corresponding to the i'th intermediate evaluation.
    const fn wires_intermediate_eval(&self, i: usize) -> Range<usize> {
        debug_assert!(i < self.num_intermediates());
        let start = self.start_intermediates() + D * i;
        start..start + D
    }

    /// The wires corresponding to the i'th intermediate product.
    const fn wires_intermediate_prod(&self, i: usize) -> Range<usize> {
        debug_assert!(i < self.num_intermediates());
        let start = self.start_intermediates() + D * (self.num_intermediates() + i);
        start..start + D
    }

    /// End of wire indices, exclusive.
    const fn end(&self) -> usize {
        self.wire_shift_inverse() + 1
    }

    /// Wire indices of the shifted point to evaluate the interpolant at.
    const fn wires_shifted_evaluation_point(&self) -> Range<usize> {
        let start = self.start_intermediates() + D * 2 * self.num_intermediates();
        start..start + D
    }

    const fn wire_shift_inverse(&self) -> usize {
        self.start_intermediates() + D * (2 * self.num_intermediates() + 1)
    }
}

impl<F: RichField + Extendable<D>, const D: usize> VerificationGate<F, D>
    for CosetInterpolationGate<F, D>
{
    fn id(&self) -> String {
        format!("{self:?}<D={D}>")
    }

    fn serialize(&self, dst: &mut Vec<u8>, _common_data: &CommonCircuitData<F, D>) -> IoResult<()> {
        dst.write_usize(self.subgroup_bits)?;
        dst.write_usize(self.degree)?;
        dst.write_usize(self.barycentric_weights.len())?;
        dst.write_field_vec(&self.barycentric_weights)
    }

    fn deserialize(src: &mut Buffer, _common_data: &CommonCircuitData<F, D>) -> IoResult<Self> {
        let subgroup_bits = src.read_usize()?;
        let degree = src.read_usize()?;
        let length = src.read_usize()?;
        let barycentric_weights: Vec<F> = src.read_field_vec(length)?;
        Ok(Self {
            subgroup_bits,
            degree,
            barycentric_weights,
            _phantom: PhantomData,
        })
    }

    fn eval_unfiltered(&self, vars: EvaluationVars<F, D>) -> Vec<F::Extension> {
        let mut constraints = Vec::with_capacity(self.num_constraints());

        let shift = vars.local_wires[self.wire_shift()];
        let shift_inverse = vars.local_wires[self.wire_shift_inverse()];
        let evaluation_point = vars.get_local_ext_algebra(self.wires_evaluation_point());
        let shifted_evaluation_point =
            vars.get_local_ext_algebra(self.wires_shifted_evaluation_point());
        constraints.push(shift * shift_inverse - F::Extension::ONE);
        constraints.extend(
            (evaluation_point - shifted_evaluation_point.scalar_mul(shift)).to_basefield_array(),
        );

        let domain = F::two_adic_subgroup(self.subgroup_bits);
        let values = (0..self.num_points())
            .map(|i| vars.get_local_ext_algebra(self.wires_value(i)))
            .collect::<Vec<_>>();
        let weights = &self.barycentric_weights;

        let (mut computed_eval, mut computed_prod) = partial_interpolate_ext_algebra(
            &domain[..self.degree()],
            &values[..self.degree()],
            &weights[..self.degree()],
            shifted_evaluation_point,
            ExtensionAlgebra::ZERO,
            ExtensionAlgebra::one(),
        );

        for i in 0..self.num_intermediates() {
            let intermediate_eval = vars.get_local_ext_algebra(self.wires_intermediate_eval(i));
            let intermediate_prod = vars.get_local_ext_algebra(self.wires_intermediate_prod(i));
            constraints.extend((intermediate_eval - computed_eval).to_basefield_array());
            constraints.extend((intermediate_prod - computed_prod).to_basefield_array());

            let start_index = 1 + (self.degree() - 1) * (i + 1);
            let end_index = (start_index + self.degree() - 1).min(self.num_points());
            (computed_eval, computed_prod) = partial_interpolate_ext_algebra(
                &domain[start_index..end_index],
                &values[start_index..end_index],
                &weights[start_index..end_index],
                shifted_evaluation_point,
                intermediate_eval,
                intermediate_prod,
            );
        }

        let evaluation_value = vars.get_local_ext_algebra(self.wires_evaluation_value());
        constraints.extend((evaluation_value - computed_eval).to_basefield_array());

        constraints
    }

    fn eval_unfiltered_base_one(
        &self,
        vars: EvaluationVarsBase<F>,
        mut yield_constr: StridedConstraintConsumer<F>,
    ) {
        let shift = vars.local_wires[self.wire_shift()];
        let shift_inverse = vars.local_wires[self.wire_shift_inverse()];
        let evaluation_point = vars.get_local_ext(self.wires_evaluation_point());
        let shifted_evaluation_point = vars.get_local_ext(self.wires_shifted_evaluation_point());
        yield_constr.one(shift * shift_inverse - F::ONE);
        yield_constr.many(
            (evaluation_point - shifted_evaluation_point.scalar_mul(shift)).to_basefield_array(),
        );

        let domain = F::two_adic_subgroup(self.subgroup_bits);
        let values = (0..self.num_points())
            .map(|i| vars.get_local_ext(self.wires_value(i)))
            .collect::<Vec<_>>();
        let weights = &self.barycentric_weights;

        let (mut computed_eval, mut computed_prod) = partial_interpolate(
            &domain[..self.degree()],
            &values[..self.degree()],
            &weights[..self.degree()],
            shifted_evaluation_point,
            F::Extension::ZERO,
            F::Extension::ONE,
        );

        for i in 0..self.num_intermediates() {
            let intermediate_eval = vars.get_local_ext(self.wires_intermediate_eval(i));
            let intermediate_prod = vars.get_local_ext(self.wires_intermediate_prod(i));
            yield_constr.many((intermediate_eval - computed_eval).to_basefield_array());
            yield_constr.many((intermediate_prod - computed_prod).to_basefield_array());

            let start_index = 1 + (self.degree() - 1) * (i + 1);
            let end_index = (start_index + self.degree() - 1).min(self.num_points());
            (computed_eval, computed_prod) = partial_interpolate(
                &domain[start_index..end_index],
                &values[start_index..end_index],
                &weights[start_index..end_index],
                shifted_evaluation_point,
                intermediate_eval,
                intermediate_prod,
            );
        }

        let evaluation_value = vars.get_local_ext(self.wires_evaluation_value());
        yield_constr.many((evaluation_value - computed_eval).to_basefield_array());
    }

    fn num_wires(&self) -> usize {
        self.end()
    }

    fn num_constants(&self) -> usize {
        0
    }

    fn degree(&self) -> usize {
        self.degree
    }

    fn num_constraints(&self) -> usize {
        // D constraints to check for consistency of the shifted evaluation point, plus D
        // constraints for the evaluation value.
        1 + D + D + 2 * D * self.num_intermediates()
    }
}

/// Interpolate the polynomial defined by its values on an arbitrary domain at the given point `x`.
///
/// The domain lies in a base field while the values and evaluation point may be from an extension
/// field. The Barycentric weights are precomputed and taken as arguments.
pub fn interpolate_over_base_domain<F: Field + Extendable<D>, const D: usize>(
    domain: &[F],
    values: &[F::Extension],
    barycentric_weights: &[F],
    x: F::Extension,
) -> F::Extension {
    let (result, _) = partial_interpolate(
        domain,
        values,
        barycentric_weights,
        x,
        F::Extension::ZERO,
        F::Extension::ONE,
    );
    result
}

/// Perform a partial interpolation of the polynomial defined by its values on an arbitrary domain.
///
/// The Barycentric algorithm to interpolate a polynomial at a given point `x` is a linear pass
/// over the sequence of domain points, values, and Barycentric weights which maintains two
/// accumulated values, a partial evaluation and a partial product. This partially updates the
/// accumulated values, so that starting with an initial evaluation of 0 and a partial evaluation
/// of 1 and running over the whole domain is a full interpolation.
fn partial_interpolate<F: Field + Extendable<D>, const D: usize>(
    domain: &[F],
    values: &[F::Extension],
    barycentric_weights: &[F],
    x: F::Extension,
    initial_eval: F::Extension,
    initial_partial_prod: F::Extension,
) -> (F::Extension, F::Extension) {
    let n = domain.len();
    assert_ne!(n, 0);
    assert_eq!(n, values.len());
    assert_eq!(n, barycentric_weights.len());

    let weighted_values = values
        .iter()
        .zip(barycentric_weights.iter())
        .map(|(&value, &weight)| value.scalar_mul(weight));

    weighted_values.zip(domain.iter()).fold(
        (initial_eval, initial_partial_prod),
        |(eval, terms_partial_prod), (val, &x_i)| {
            let term = x - x_i.into();
            let next_eval = eval * term + val * terms_partial_prod;
            let next_terms_partial_prod = terms_partial_prod * term;
            (next_eval, next_terms_partial_prod)
        },
    )
}

fn partial_interpolate_ext_algebra<F: OEF<D>, const D: usize>(
    domain: &[F::BaseField],
    values: &[ExtensionAlgebra<F, D>],
    barycentric_weights: &[F::BaseField],
    x: ExtensionAlgebra<F, D>,
    initial_eval: ExtensionAlgebra<F, D>,
    initial_partial_prod: ExtensionAlgebra<F, D>,
) -> (ExtensionAlgebra<F, D>, ExtensionAlgebra<F, D>) {
    let n = domain.len();
    assert_ne!(n, 0);
    assert_eq!(n, values.len());
    assert_eq!(n, barycentric_weights.len());

    let weighted_values = values
        .iter()
        .zip(barycentric_weights.iter())
        .map(|(&value, &weight)| value.scalar_mul(F::from_basefield(weight)));

    weighted_values.zip(domain.iter()).fold(
        (initial_eval, initial_partial_prod),
        |(eval, terms_partial_prod), (val, &x_i)| {
            let term = x - F::from_basefield(x_i).into();
            let next_eval = eval * term + val * terms_partial_prod;
            let next_terms_partial_prod = terms_partial_prod * term;
            (next_eval, next_terms_partial_prod)
        },
    )
}

#[cfg(test)]
mod tests {
    use plonky2_field::goldilocks_field::GoldilocksField;

    use super::*;

    #[test]
    fn test_num_wires_constraints() {
        let gate = <CosetInterpolationGate<GoldilocksField, 2>>::with_max_degree(4, 8);
        assert_eq!(gate.num_wires(), 48);
        assert_eq!(gate.num_constraints(), 13);

        let gate = <CosetInterpolationGate<GoldilocksField, 2>>::with_max_degree(3, 8);
        assert_eq!(gate.num_wires(), 24);
        assert_eq!(gate.num_constraints(), 5);

        let gate = <CosetInterpolationGate<GoldilocksField, 2>>::with_max_degree(4, 16);
        assert_eq!(gate.num_wires(), 40);
        assert_eq!(gate.num_constraints(), 5);
    }
}
