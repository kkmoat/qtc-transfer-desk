#[cfg(not(feature = "std"))]
use alloc::{format, string::String, vec, vec::Vec};
use core::ops::Range;

use crate::field::extension::Extendable;
use crate::field::packed::PackedField;
use crate::field::types::{Field, Field64};
use crate::gates::gate::VerificationGate;
use crate::gates::packed_util::PackedEvaluableBase;
use crate::gates::util::StridedConstraintConsumer;
use crate::hash::hash_types::RichField;
use crate::plonk::circuit_data::{CircuitConfig, CommonCircuitData};
use crate::plonk::plonk_common::reduce_with_powers;
use crate::plonk::vars::{
    EvaluationVars, EvaluationVarsBase, EvaluationVarsBaseBatch, EvaluationVarsBasePacked,
};
use crate::util::log_floor;
use crate::util::serialization::{Buffer, IoResult, Read, Write};

/// A gate which can decompose a number into base B little-endian limbs.
#[derive(Copy, Clone, Debug)]
pub struct BaseSumGate<const B: usize> {
    pub num_limbs: usize,
}

impl<const B: usize> BaseSumGate<B> {
    pub const fn new(num_limbs: usize) -> Self {
        Self { num_limbs }
    }

    pub fn new_from_config<F: Field64>(config: &CircuitConfig) -> Self {
        let num_limbs =
            log_floor(F::ORDER - 1, B as u64).min(config.num_routed_wires - Self::START_LIMBS);
        Self::new(num_limbs)
    }

    pub(crate) const WIRE_SUM: usize = 0;
    pub(crate) const START_LIMBS: usize = 1;

    /// Returns the index of the `i`th limb wire.
    pub(crate) const fn limbs(&self) -> Range<usize> {
        Self::START_LIMBS..Self::START_LIMBS + self.num_limbs
    }
}

impl<F: RichField + Extendable<D>, const D: usize, const B: usize> VerificationGate<F, D>
    for BaseSumGate<B>
{
    fn id(&self) -> String {
        format!("{self:?} + Base: {B}")
    }

    fn serialize(&self, dst: &mut Vec<u8>, _common_data: &CommonCircuitData<F, D>) -> IoResult<()> {
        dst.write_usize(self.num_limbs)
    }

    fn deserialize(src: &mut Buffer, _common_data: &CommonCircuitData<F, D>) -> IoResult<Self> {
        let num_limbs = src.read_usize()?;
        Ok(Self { num_limbs })
    }

    fn eval_unfiltered(&self, vars: EvaluationVars<F, D>) -> Vec<F::Extension> {
        let sum = vars.local_wires[Self::WIRE_SUM];
        let limbs = vars.local_wires[self.limbs()].to_vec();
        let computed_sum = reduce_with_powers(&limbs, F::Extension::from_canonical_usize(B));
        let mut constraints = vec![computed_sum - sum];
        for limb in limbs {
            constraints.push(
                (0..B)
                    .map(|i| limb - F::Extension::from_canonical_usize(i))
                    .product(),
            );
        }
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

    // 1 for the sum then `num_limbs` for the limbs.
    fn num_wires(&self) -> usize {
        1 + self.num_limbs
    }

    fn num_constants(&self) -> usize {
        0
    }

    // Bounded by the range-check (x-0)*(x-1)*...*(x-B+1).
    fn degree(&self) -> usize {
        B
    }

    // 1 for checking the sum then `num_limbs` for range-checking the limbs.
    fn num_constraints(&self) -> usize {
        1 + self.num_limbs
    }
}

impl<F: RichField + Extendable<D>, const D: usize, const B: usize> PackedEvaluableBase<F, D>
    for BaseSumGate<B>
{
    fn eval_unfiltered_base_packed<P: PackedField<Scalar = F>>(
        &self,
        vars: EvaluationVarsBasePacked<P>,
        mut yield_constr: StridedConstraintConsumer<P>,
    ) {
        let sum = vars.local_wires[Self::WIRE_SUM];
        let limbs = vars.local_wires.view(self.limbs());
        let computed_sum = reduce_with_powers(limbs, F::from_canonical_usize(B));

        yield_constr.one(computed_sum - sum);

        let constraints_iter = limbs.iter().map(|&limb| {
            (0..B)
                .map(|i| limb - F::from_canonical_usize(i))
                .product::<P>()
        });
        yield_constr.many(constraints_iter);
    }
}
