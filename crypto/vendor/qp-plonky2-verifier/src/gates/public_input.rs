#[cfg(not(feature = "std"))]
use alloc::{string::String, vec::Vec};
use core::ops::Range;

use crate::field::extension::Extendable;
use crate::field::packed::PackedField;
use crate::gates::gate::VerificationGate;
use crate::gates::packed_util::PackedEvaluableBase;
use crate::gates::util::StridedConstraintConsumer;
use crate::hash::hash_types::RichField;
use crate::plonk::circuit_data::CommonCircuitData;
use crate::plonk::vars::{
    EvaluationVars, EvaluationVarsBase, EvaluationVarsBaseBatch, EvaluationVarsBasePacked,
};
use crate::util::serialization::{Buffer, IoResult};

/// A gate whose first four wires will be equal to a hash of public inputs.
#[derive(Debug)]
pub struct PublicInputGate;

impl PublicInputGate {
    pub(crate) const fn wires_public_inputs_hash() -> Range<usize> {
        0..4
    }
}

impl<F: RichField + Extendable<D>, const D: usize> VerificationGate<F, D> for PublicInputGate {
    fn id(&self) -> String {
        "PublicInputGate".into()
    }

    fn serialize(
        &self,
        _dst: &mut Vec<u8>,
        _common_data: &CommonCircuitData<F, D>,
    ) -> IoResult<()> {
        Ok(())
    }

    fn deserialize(_src: &mut Buffer, _common_data: &CommonCircuitData<F, D>) -> IoResult<Self> {
        Ok(Self)
    }

    fn eval_unfiltered(&self, vars: EvaluationVars<F, D>) -> Vec<F::Extension> {
        Self::wires_public_inputs_hash()
            .zip(vars.public_inputs_hash.elements)
            .map(|(wire, hash_part)| vars.local_wires[wire] - hash_part.into())
            .collect()
    }

    fn eval_unfiltered_base_one(
        &self,
        _vars: EvaluationVarsBase<F>,
        _yield_constr: StridedConstraintConsumer<F>,
    ) {
        panic!("use eval_unfiltered_base_packed instead");
    }

    fn eval_unfiltered_base_batch(&self, vars_base: EvaluationVarsBaseBatch<F>) -> Vec<F> {
        self.eval_unfiltered_base_batch_packed(vars_base)
    }

    fn num_wires(&self) -> usize {
        4
    }

    fn num_constants(&self) -> usize {
        0
    }

    fn degree(&self) -> usize {
        1
    }

    fn num_constraints(&self) -> usize {
        4
    }
}

impl<F: RichField + Extendable<D>, const D: usize> PackedEvaluableBase<F, D> for PublicInputGate {
    fn eval_unfiltered_base_packed<P: PackedField<Scalar = F>>(
        &self,
        vars: EvaluationVarsBasePacked<P>,
        mut yield_constr: StridedConstraintConsumer<P>,
    ) {
        yield_constr.many(
            Self::wires_public_inputs_hash()
                .zip(vars.public_inputs_hash.elements)
                .map(|(wire, hash_part)| vars.local_wires[wire] - hash_part),
        )
    }
}
