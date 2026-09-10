#[cfg(not(feature = "std"))]
use alloc::{format, string::String, vec::Vec};

use serde::{Deserialize, Serialize};

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
use crate::util::serialization::{Buffer, IoResult, Read, Write};

/// A gate which takes a single constant parameter and outputs that value.
#[derive(Copy, Clone, Debug, Serialize, Deserialize)]
pub struct ConstantGate {
    pub(crate) num_consts: usize,
}

impl ConstantGate {
    pub const fn new(num_consts: usize) -> Self {
        Self { num_consts }
    }

    const fn const_input(&self, i: usize) -> usize {
        debug_assert!(i < self.num_consts);
        i
    }

    const fn wire_output(&self, i: usize) -> usize {
        debug_assert!(i < self.num_consts);
        i
    }
}

impl<F: RichField + Extendable<D>, const D: usize> VerificationGate<F, D> for ConstantGate {
    fn id(&self) -> String {
        format!("{self:?}")
    }

    fn serialize(&self, dst: &mut Vec<u8>, _common_data: &CommonCircuitData<F, D>) -> IoResult<()> {
        dst.write_usize(self.num_consts)
    }

    fn deserialize(src: &mut Buffer, _common_data: &CommonCircuitData<F, D>) -> IoResult<Self> {
        let num_consts = src.read_usize()?;
        Ok(Self { num_consts })
    }

    fn eval_unfiltered(&self, vars: EvaluationVars<F, D>) -> Vec<F::Extension> {
        (0..self.num_consts)
            .map(|i| {
                vars.local_constants[self.const_input(i)] - vars.local_wires[self.wire_output(i)]
            })
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
        self.num_consts
    }

    fn num_constants(&self) -> usize {
        self.num_consts
    }

    fn degree(&self) -> usize {
        1
    }

    fn num_constraints(&self) -> usize {
        self.num_consts
    }

    fn extra_constant_wires(&self) -> Vec<(usize, usize)> {
        (0..self.num_consts)
            .map(|i| (self.const_input(i), self.wire_output(i)))
            .collect()
    }
}

impl<F: RichField + Extendable<D>, const D: usize> PackedEvaluableBase<F, D> for ConstantGate {
    fn eval_unfiltered_base_packed<P: PackedField<Scalar = F>>(
        &self,
        vars: EvaluationVarsBasePacked<P>,
        mut yield_constr: StridedConstraintConsumer<P>,
    ) {
        yield_constr.many((0..self.num_consts).map(|i| {
            vars.local_constants[self.const_input(i)] - vars.local_wires[self.wire_output(i)]
        }));
    }
}
