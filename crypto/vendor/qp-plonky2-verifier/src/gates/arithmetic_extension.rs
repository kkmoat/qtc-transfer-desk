#[cfg(not(feature = "std"))]
use alloc::{format, string::String, vec::Vec};
use core::ops::Range;

use crate::field::extension::{Extendable, FieldExtension};
use crate::gates::gate::VerificationGate;
use crate::gates::util::StridedConstraintConsumer;
use crate::hash::hash_types::RichField;
use crate::plonk::circuit_data::{CircuitConfig, CommonCircuitData};
use crate::plonk::vars::{EvaluationVars, EvaluationVarsBase};
use crate::util::serialization::{Buffer, IoResult, Read, Write};

/// A gate which can perform a weighted multiply-add, i.e. `result = c0.x.y + c1.z`. If the config
/// has enough routed wires, it can support several such operations in one gate.
#[derive(Debug, Clone)]
pub struct ArithmeticExtensionGate<const D: usize> {
    /// Number of arithmetic operations performed by an arithmetic gate.
    pub num_ops: usize,
}

impl<const D: usize> ArithmeticExtensionGate<D> {
    pub const fn new_from_config(config: &CircuitConfig) -> Self {
        Self {
            num_ops: Self::num_ops(config),
        }
    }

    /// Determine the maximum number of operations that can fit in one gate for the given config.
    pub(crate) const fn num_ops(config: &CircuitConfig) -> usize {
        let wires_per_op = 4 * D;
        config.num_routed_wires / wires_per_op
    }

    pub(crate) const fn wires_ith_multiplicand_0(i: usize) -> Range<usize> {
        4 * D * i..4 * D * i + D
    }
    pub(crate) const fn wires_ith_multiplicand_1(i: usize) -> Range<usize> {
        4 * D * i + D..4 * D * i + 2 * D
    }
    pub(crate) const fn wires_ith_addend(i: usize) -> Range<usize> {
        4 * D * i + 2 * D..4 * D * i + 3 * D
    }
    pub(crate) const fn wires_ith_output(i: usize) -> Range<usize> {
        4 * D * i + 3 * D..4 * D * i + 4 * D
    }
}

impl<F: RichField + Extendable<D>, const D: usize> VerificationGate<F, D>
    for ArithmeticExtensionGate<D>
{
    fn id(&self) -> String {
        format!("{self:?}")
    }

    fn serialize(&self, dst: &mut Vec<u8>, _common_data: &CommonCircuitData<F, D>) -> IoResult<()> {
        dst.write_usize(self.num_ops)
    }

    fn deserialize(src: &mut Buffer, _common_data: &CommonCircuitData<F, D>) -> IoResult<Self> {
        let num_ops = src.read_usize()?;
        Ok(Self { num_ops })
    }

    fn eval_unfiltered(&self, vars: EvaluationVars<F, D>) -> Vec<F::Extension> {
        let const_0 = vars.local_constants[0];
        let const_1 = vars.local_constants[1];

        let mut constraints = Vec::with_capacity(self.num_ops * D);
        for i in 0..self.num_ops {
            let multiplicand_0 = vars.get_local_ext_algebra(Self::wires_ith_multiplicand_0(i));
            let multiplicand_1 = vars.get_local_ext_algebra(Self::wires_ith_multiplicand_1(i));
            let addend = vars.get_local_ext_algebra(Self::wires_ith_addend(i));
            let output = vars.get_local_ext_algebra(Self::wires_ith_output(i));
            let computed_output =
                (multiplicand_0 * multiplicand_1).scalar_mul(const_0) + addend.scalar_mul(const_1);

            constraints.extend((output - computed_output).to_basefield_array());
        }

        constraints
    }

    fn eval_unfiltered_base_one(
        &self,
        vars: EvaluationVarsBase<F>,
        mut yield_constr: StridedConstraintConsumer<F>,
    ) {
        let const_0 = vars.local_constants[0];
        let const_1 = vars.local_constants[1];

        for i in 0..self.num_ops {
            let multiplicand_0 = vars.get_local_ext(Self::wires_ith_multiplicand_0(i));
            let multiplicand_1 = vars.get_local_ext(Self::wires_ith_multiplicand_1(i));
            let addend = vars.get_local_ext(Self::wires_ith_addend(i));
            let output = vars.get_local_ext(Self::wires_ith_output(i));
            let computed_output =
                (multiplicand_0 * multiplicand_1).scalar_mul(const_0) + addend.scalar_mul(const_1);

            yield_constr.many((output - computed_output).to_basefield_array());
        }
    }

    fn num_wires(&self) -> usize {
        self.num_ops * 4 * D
    }

    fn num_constants(&self) -> usize {
        2
    }

    fn degree(&self) -> usize {
        3
    }

    fn num_constraints(&self) -> usize {
        self.num_ops * D
    }
}
