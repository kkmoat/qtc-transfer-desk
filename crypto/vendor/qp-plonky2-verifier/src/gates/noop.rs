#[cfg(not(feature = "std"))]
use alloc::{string::String, vec::Vec};

use crate::field::extension::Extendable;
use crate::gates::gate::VerificationGate;
use crate::hash::hash_types::RichField;
use crate::plonk::circuit_data::CommonCircuitData;
use crate::plonk::vars::{EvaluationVars, EvaluationVarsBaseBatch};
use crate::util::serialization::{Buffer, IoResult};

/// A gate which does nothing.
#[derive(Debug)]
pub struct NoopGate;

impl<F: RichField + Extendable<D>, const D: usize> VerificationGate<F, D> for NoopGate {
    fn id(&self) -> String {
        "NoopGate".into()
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

    fn eval_unfiltered(&self, _vars: EvaluationVars<F, D>) -> Vec<F::Extension> {
        Vec::new()
    }

    fn eval_unfiltered_base_batch(&self, _vars: EvaluationVarsBaseBatch<F>) -> Vec<F> {
        Vec::new()
    }

    fn num_wires(&self) -> usize {
        0
    }

    fn num_constants(&self) -> usize {
        0
    }

    fn degree(&self) -> usize {
        0
    }

    fn num_constraints(&self) -> usize {
        0
    }
}
