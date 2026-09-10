#[cfg(not(feature = "std"))]
use alloc::{format, string::String, vec::Vec};
use core::marker::PhantomData;
use core::ops::Range;

use qp_plonky2_core::poseidon::{Poseidon, SPONGE_WIDTH};

use crate::field::extension::algebra::ExtensionAlgebra;
use crate::field::extension::{Extendable, FieldExtension};
use crate::field::types::Field;
use crate::gates::gate::VerificationGate;
use crate::gates::util::StridedConstraintConsumer;
use crate::hash::hash_types::RichField;
use crate::plonk::circuit_data::CommonCircuitData;
use crate::plonk::vars::{EvaluationVars, EvaluationVarsBase};
use crate::util::serialization::{Buffer, IoResult};

/// Poseidon MDS Gate
#[derive(Debug, Default)]
pub struct PoseidonMdsGate<F: RichField + Extendable<D> + Poseidon, const D: usize>(PhantomData<F>);

impl<F: RichField + Extendable<D> + Poseidon, const D: usize> PoseidonMdsGate<F, D> {
    pub const fn new() -> Self {
        Self(PhantomData)
    }

    pub(crate) const fn wires_input(i: usize) -> Range<usize> {
        assert!(i < SPONGE_WIDTH);
        i * D..(i + 1) * D
    }

    pub(crate) const fn wires_output(i: usize) -> Range<usize> {
        assert!(i < SPONGE_WIDTH);
        (SPONGE_WIDTH + i) * D..(SPONGE_WIDTH + i + 1) * D
    }

    // Following are methods analogous to ones in `Poseidon`, but for extension algebras.

    /// Same as `mds_row_shf` for an extension algebra of `F`.
    fn mds_row_shf_algebra(
        r: usize,
        v: &[ExtensionAlgebra<F::Extension, D>; SPONGE_WIDTH],
    ) -> ExtensionAlgebra<F::Extension, D> {
        debug_assert!(r < SPONGE_WIDTH);
        let mut res = ExtensionAlgebra::ZERO;

        for i in 0..SPONGE_WIDTH {
            let coeff = F::Extension::from_canonical_u64(<F as Poseidon>::MDS_MATRIX_CIRC[i]);
            res += v[(i + r) % SPONGE_WIDTH].scalar_mul(coeff);
        }
        {
            let coeff = F::Extension::from_canonical_u64(<F as Poseidon>::MDS_MATRIX_DIAG[r]);
            res += v[r].scalar_mul(coeff);
        }

        res
    }

    /// Same as `mds_layer` for an extension algebra of `F`.
    fn mds_layer_algebra(
        state: &[ExtensionAlgebra<F::Extension, D>; SPONGE_WIDTH],
    ) -> [ExtensionAlgebra<F::Extension, D>; SPONGE_WIDTH] {
        let mut result = [ExtensionAlgebra::ZERO; SPONGE_WIDTH];

        for r in 0..SPONGE_WIDTH {
            result[r] = Self::mds_row_shf_algebra(r, state);
        }

        result
    }
}

impl<F: RichField + Extendable<D> + Poseidon, const D: usize> VerificationGate<F, D>
    for PoseidonMdsGate<F, D>
{
    fn id(&self) -> String {
        format!("{self:?}<WIDTH={SPONGE_WIDTH}>")
    }

    fn serialize(
        &self,
        _dst: &mut Vec<u8>,
        _common_data: &CommonCircuitData<F, D>,
    ) -> IoResult<()> {
        Ok(())
    }

    fn deserialize(_src: &mut Buffer, _common_data: &CommonCircuitData<F, D>) -> IoResult<Self> {
        Ok(PoseidonMdsGate::new())
    }

    fn eval_unfiltered(&self, vars: EvaluationVars<F, D>) -> Vec<F::Extension> {
        let inputs: [_; SPONGE_WIDTH] = (0..SPONGE_WIDTH)
            .map(|i| vars.get_local_ext_algebra(Self::wires_input(i)))
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();

        let computed_outputs = Self::mds_layer_algebra(&inputs);

        (0..SPONGE_WIDTH)
            .map(|i| vars.get_local_ext_algebra(Self::wires_output(i)))
            .zip(computed_outputs)
            .flat_map(|(out, computed_out)| (out - computed_out).to_basefield_array())
            .collect()
    }

    fn eval_unfiltered_base_one(
        &self,
        vars: EvaluationVarsBase<F>,
        mut yield_constr: StridedConstraintConsumer<F>,
    ) {
        let inputs: [_; SPONGE_WIDTH] = (0..SPONGE_WIDTH)
            .map(|i| vars.get_local_ext(Self::wires_input(i)))
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();

        let computed_outputs = F::mds_layer_field(&inputs);

        yield_constr.many(
            (0..SPONGE_WIDTH)
                .map(|i| vars.get_local_ext(Self::wires_output(i)))
                .zip(computed_outputs)
                .flat_map(|(out, computed_out)| (out - computed_out).to_basefield_array()),
        )
    }

    fn num_wires(&self) -> usize {
        2 * D * SPONGE_WIDTH
    }

    fn num_constants(&self) -> usize {
        0
    }

    fn degree(&self) -> usize {
        1
    }

    fn num_constraints(&self) -> usize {
        SPONGE_WIDTH * D
    }
}
