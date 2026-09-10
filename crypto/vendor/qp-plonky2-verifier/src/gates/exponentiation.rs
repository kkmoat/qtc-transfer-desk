#[cfg(not(feature = "std"))]
use alloc::{format, string::String, vec::Vec};
use core::marker::PhantomData;

use crate::field::extension::Extendable;
use crate::field::ops::Square;
use crate::field::packed::PackedField;
use crate::field::types::Field;
use crate::gates::gate::VerificationGate;
use crate::gates::packed_util::PackedEvaluableBase;
use crate::gates::util::StridedConstraintConsumer;
use crate::hash::hash_types::RichField;
use crate::plonk::circuit_data::{CircuitConfig, CommonCircuitData};
use crate::plonk::vars::{
    EvaluationVars, EvaluationVarsBase, EvaluationVarsBaseBatch, EvaluationVarsBasePacked,
};
use crate::util::serialization::{Buffer, IoResult, Read, Write};

/// A gate for raising a value to a power.
#[derive(Clone, Debug, Default)]
pub struct ExponentiationGate<F: RichField + Extendable<D>, const D: usize> {
    pub num_power_bits: usize,
    pub _phantom: PhantomData<F>,
}

impl<F: RichField + Extendable<D>, const D: usize> ExponentiationGate<F, D> {
    pub const fn new(num_power_bits: usize) -> Self {
        Self {
            num_power_bits,
            _phantom: PhantomData,
        }
    }

    pub fn new_from_config(config: &CircuitConfig) -> Self {
        let num_power_bits = Self::max_power_bits(config.num_wires, config.num_routed_wires);
        Self::new(num_power_bits)
    }

    fn max_power_bits(num_wires: usize, num_routed_wires: usize) -> usize {
        // 2 wires are reserved for the base and output.
        let max_for_routed_wires = num_routed_wires - 2;
        let max_for_wires = (num_wires - 2) / 2;
        max_for_routed_wires.min(max_for_wires)
    }

    pub(crate) const fn wire_base(&self) -> usize {
        0
    }

    /// The `i`th bit of the exponent, in little-endian order.
    pub(crate) const fn wire_power_bit(&self, i: usize) -> usize {
        debug_assert!(i < self.num_power_bits);
        1 + i
    }

    pub const fn wire_output(&self) -> usize {
        1 + self.num_power_bits
    }

    pub(crate) const fn wire_intermediate_value(&self, i: usize) -> usize {
        debug_assert!(i < self.num_power_bits);
        2 + self.num_power_bits + i
    }
}

impl<F: RichField + Extendable<D>, const D: usize> VerificationGate<F, D>
    for ExponentiationGate<F, D>
{
    fn id(&self) -> String {
        format!("{self:?}<D={D}>")
    }

    fn serialize(&self, dst: &mut Vec<u8>, _common_data: &CommonCircuitData<F, D>) -> IoResult<()> {
        dst.write_usize(self.num_power_bits)
    }

    fn deserialize(src: &mut Buffer, _common_data: &CommonCircuitData<F, D>) -> IoResult<Self> {
        let num_power_bits = src.read_usize()?;
        Ok(Self::new(num_power_bits))
    }

    fn eval_unfiltered(&self, vars: EvaluationVars<F, D>) -> Vec<F::Extension> {
        let base = vars.local_wires[self.wire_base()];

        let power_bits: Vec<_> = (0..self.num_power_bits)
            .map(|i| vars.local_wires[self.wire_power_bit(i)])
            .collect();
        let intermediate_values: Vec<_> = (0..self.num_power_bits)
            .map(|i| vars.local_wires[self.wire_intermediate_value(i)])
            .collect();

        let output = vars.local_wires[self.wire_output()];

        let mut constraints = Vec::with_capacity(self.num_constraints());

        for i in 0..self.num_power_bits {
            let prev_intermediate_value = if i == 0 {
                F::Extension::ONE
            } else {
                intermediate_values[i - 1].square()
            };

            // power_bits is in LE order, but we accumulate in BE order.
            let cur_bit = power_bits[self.num_power_bits - i - 1];

            let not_cur_bit = F::Extension::ONE - cur_bit;
            let computed_intermediate_value =
                prev_intermediate_value * (cur_bit * base + not_cur_bit);
            constraints.push(computed_intermediate_value - intermediate_values[i]);
        }

        constraints.push(output - intermediate_values[self.num_power_bits - 1]);

        constraints
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
        self.wire_intermediate_value(self.num_power_bits - 1) + 1
    }

    fn num_constants(&self) -> usize {
        0
    }

    fn degree(&self) -> usize {
        4
    }

    fn num_constraints(&self) -> usize {
        self.num_power_bits + 1
    }
}

impl<F: RichField + Extendable<D>, const D: usize> PackedEvaluableBase<F, D>
    for ExponentiationGate<F, D>
{
    fn eval_unfiltered_base_packed<P: PackedField<Scalar = F>>(
        &self,
        vars: EvaluationVarsBasePacked<P>,
        mut yield_constr: StridedConstraintConsumer<P>,
    ) {
        let base = vars.local_wires[self.wire_base()];

        let power_bits: Vec<_> = (0..self.num_power_bits)
            .map(|i| vars.local_wires[self.wire_power_bit(i)])
            .collect();
        let intermediate_values: Vec<_> = (0..self.num_power_bits)
            .map(|i| vars.local_wires[self.wire_intermediate_value(i)])
            .collect();

        let output = vars.local_wires[self.wire_output()];

        for i in 0..self.num_power_bits {
            let prev_intermediate_value = if i == 0 {
                P::ONES
            } else {
                intermediate_values[i - 1].square()
            };

            // power_bits is in LE order, but we accumulate in BE order.
            let cur_bit = power_bits[self.num_power_bits - i - 1];

            let not_cur_bit = P::ONES - cur_bit;
            let computed_intermediate_value =
                prev_intermediate_value * (cur_bit * base + not_cur_bit);
            yield_constr.one(computed_intermediate_value - intermediate_values[i]);
        }

        yield_constr.one(output - intermediate_values[self.num_power_bits - 1]);
    }
}
