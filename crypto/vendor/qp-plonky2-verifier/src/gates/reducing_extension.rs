#[cfg(not(feature = "std"))]
use alloc::{format, string::String, vec::Vec};
use core::ops::Range;

use crate::field::extension::{Extendable, FieldExtension};
use crate::gates::gate::VerificationGate;
use crate::gates::util::StridedConstraintConsumer;
use crate::hash::hash_types::RichField;
use crate::plonk::circuit_data::CommonCircuitData;
use crate::plonk::vars::{EvaluationVars, EvaluationVarsBase};
use crate::util::serialization::{Buffer, IoResult, Read, Write};

/// Computes `sum alpha^i c_i` for a vector `c_i` of `num_coeffs` elements of the extension field.
#[derive(Debug, Clone, Default)]
pub struct ReducingExtensionGate<const D: usize> {
    pub num_coeffs: usize,
}

impl<const D: usize> ReducingExtensionGate<D> {
    pub const fn new(num_coeffs: usize) -> Self {
        assert!(num_coeffs > 0);
        Self { num_coeffs }
    }

    pub fn max_coeffs_len(num_wires: usize, num_routed_wires: usize) -> usize {
        // `3*D` routed wires are used for the output, alpha and old accumulator.
        // Need `num_coeffs*D` routed wires for coeffs, and `(num_coeffs-1)*D` wires for accumulators.
        ((num_routed_wires - 3 * D) / D).min((num_wires - 2 * D) / (D * 2))
    }

    pub(crate) const fn wires_output() -> Range<usize> {
        0..D
    }
    pub(crate) const fn wires_alpha() -> Range<usize> {
        D..2 * D
    }
    pub(crate) const fn wires_old_acc() -> Range<usize> {
        2 * D..3 * D
    }
    const START_COEFFS: usize = 3 * D;
    pub(crate) const fn wires_coeff(i: usize) -> Range<usize> {
        Self::START_COEFFS + i * D..Self::START_COEFFS + (i + 1) * D
    }
    const fn start_accs(&self) -> usize {
        Self::START_COEFFS + self.num_coeffs * D
    }
    const fn wires_accs(&self, i: usize) -> Range<usize> {
        debug_assert!(i < self.num_coeffs);
        if i == self.num_coeffs - 1 {
            // The last accumulator is the output.
            return Self::wires_output();
        }
        self.start_accs() + D * i..self.start_accs() + D * (i + 1)
    }
}

impl<F: RichField + Extendable<D>, const D: usize> VerificationGate<F, D>
    for ReducingExtensionGate<D>
{
    fn id(&self) -> String {
        format!("{self:?}")
    }

    fn serialize(&self, dst: &mut Vec<u8>, _common_data: &CommonCircuitData<F, D>) -> IoResult<()> {
        dst.write_usize(self.num_coeffs)?;
        Ok(())
    }

    fn deserialize(src: &mut Buffer, _common_data: &CommonCircuitData<F, D>) -> IoResult<Self>
    where
        Self: Sized,
    {
        let num_coeffs = src.read_usize()?;
        if num_coeffs == 0 {
            return Err(crate::util::serialization::IoError);
        }
        Ok(Self::new(num_coeffs))
    }

    fn eval_unfiltered(&self, vars: EvaluationVars<F, D>) -> Vec<F::Extension> {
        let alpha = vars.get_local_ext_algebra(Self::wires_alpha());
        let old_acc = vars.get_local_ext_algebra(Self::wires_old_acc());
        let coeffs = (0..self.num_coeffs)
            .map(|i| vars.get_local_ext_algebra(Self::wires_coeff(i)))
            .collect::<Vec<_>>();
        let accs = (0..self.num_coeffs)
            .map(|i| vars.get_local_ext_algebra(self.wires_accs(i)))
            .collect::<Vec<_>>();

        let mut constraints =
            Vec::with_capacity(<Self as VerificationGate<F, D>>::num_constraints(self));
        let mut acc = old_acc;
        for i in 0..self.num_coeffs {
            constraints.push(acc * alpha + coeffs[i] - accs[i]);
            acc = accs[i];
        }

        constraints
            .into_iter()
            .flat_map(|alg| alg.to_basefield_array())
            .collect()
    }

    fn eval_unfiltered_base_one(
        &self,
        vars: EvaluationVarsBase<F>,
        mut yield_constr: StridedConstraintConsumer<F>,
    ) {
        let alpha = vars.get_local_ext(Self::wires_alpha());
        let old_acc = vars.get_local_ext(Self::wires_old_acc());
        let coeffs = (0..self.num_coeffs)
            .map(|i| vars.get_local_ext(Self::wires_coeff(i)))
            .collect::<Vec<_>>();
        let accs = (0..self.num_coeffs)
            .map(|i| vars.get_local_ext(self.wires_accs(i)))
            .collect::<Vec<_>>();

        let mut acc = old_acc;
        for i in 0..self.num_coeffs {
            yield_constr.many((acc * alpha + coeffs[i] - accs[i]).to_basefield_array());
            acc = accs[i];
        }
    }

    fn num_wires(&self) -> usize {
        2 * D + 2 * D * self.num_coeffs
    }

    fn num_constants(&self) -> usize {
        0
    }

    fn degree(&self) -> usize {
        2
    }

    fn num_constraints(&self) -> usize {
        D * self.num_coeffs
    }
}

#[cfg(test)]
mod tests {
    use std::panic::{catch_unwind, AssertUnwindSafe};

    use super::*;

    #[test]
    fn new_zero_panics() {
        let result = catch_unwind(AssertUnwindSafe(|| ReducingExtensionGate::<2>::new(0)));
        assert!(result.is_err());
    }
}
