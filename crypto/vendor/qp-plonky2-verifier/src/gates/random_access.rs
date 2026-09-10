#[cfg(not(feature = "std"))]
use alloc::{format, string::String, vec::Vec};
use core::marker::PhantomData;

use itertools::Itertools;

use crate::field::extension::Extendable;
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

/// A gate for checking that a particular element of a list matches a given value.
#[derive(Copy, Clone, Debug, Default)]
pub struct RandomAccessGate<F: RichField + Extendable<D>, const D: usize> {
    /// Number of bits in the index (log2 of the list size).
    pub bits: usize,

    /// How many separate copies are packed into one gate.
    pub num_copies: usize,

    /// Leftover wires are used as global scratch space to store constants.
    pub num_extra_constants: usize,

    _phantom: PhantomData<F>,
}

impl<F: RichField + Extendable<D>, const D: usize> RandomAccessGate<F, D> {
    const fn new(num_copies: usize, bits: usize, num_extra_constants: usize) -> Self {
        Self {
            bits,
            num_copies,
            num_extra_constants,
            _phantom: PhantomData,
        }
    }

    pub fn new_from_config(config: &CircuitConfig, bits: usize) -> Self {
        // We can access a list of 2^bits elements.
        let vec_size = 1 << bits;

        // We need `(2 + vec_size) * num_copies` routed wires.
        let max_copies = (config.num_routed_wires / (2 + vec_size)).min(
            // We need `(2 + vec_size + bits) * num_copies` wires in total.
            config.num_wires / (2 + vec_size + bits),
        );

        // Any leftover wires can be used for constants.
        let max_extra_constants = config.num_routed_wires - (2 + vec_size) * max_copies;

        Self::new(
            max_copies,
            bits,
            max_extra_constants.min(config.num_constants),
        )
    }

    /// Length of the list being accessed.
    const fn vec_size(&self) -> usize {
        1 << self.bits
    }

    /// For each copy, a wire containing the claimed index of the element.
    pub(crate) const fn wire_access_index(&self, copy: usize) -> usize {
        debug_assert!(copy < self.num_copies);
        (2 + self.vec_size()) * copy
    }

    /// For each copy, a wire containing the element claimed to be at the index.
    pub(crate) const fn wire_claimed_element(&self, copy: usize) -> usize {
        debug_assert!(copy < self.num_copies);
        (2 + self.vec_size()) * copy + 1
    }

    /// For each copy, wires containing the entire list.
    pub(crate) const fn wire_list_item(&self, i: usize, copy: usize) -> usize {
        debug_assert!(i < self.vec_size());
        debug_assert!(copy < self.num_copies);
        (2 + self.vec_size()) * copy + 2 + i
    }

    const fn start_extra_constants(&self) -> usize {
        (2 + self.vec_size()) * self.num_copies
    }

    const fn wire_extra_constant(&self, i: usize) -> usize {
        debug_assert!(i < self.num_extra_constants);
        self.start_extra_constants() + i
    }

    /// All above wires are routed.
    pub const fn num_routed_wires(&self) -> usize {
        self.start_extra_constants() + self.num_extra_constants
    }

    /// An intermediate wire where the prover gives the (purported) binary decomposition of the
    /// index.
    pub(crate) const fn wire_bit(&self, i: usize, copy: usize) -> usize {
        debug_assert!(i < self.bits);
        debug_assert!(copy < self.num_copies);
        self.num_routed_wires() + copy * self.bits + i
    }
}

impl<F: RichField + Extendable<D>, const D: usize> VerificationGate<F, D>
    for RandomAccessGate<F, D>
{
    fn id(&self) -> String {
        format!("{self:?}<D={D}>")
    }

    fn serialize(&self, dst: &mut Vec<u8>, _common_data: &CommonCircuitData<F, D>) -> IoResult<()> {
        dst.write_usize(self.bits)?;
        dst.write_usize(self.num_copies)?;
        dst.write_usize(self.num_extra_constants)?;
        Ok(())
    }

    fn deserialize(src: &mut Buffer, _common_data: &CommonCircuitData<F, D>) -> IoResult<Self> {
        let bits = src.read_usize()?;
        let num_copies = src.read_usize()?;
        let num_extra_constants = src.read_usize()?;
        Ok(Self::new(num_copies, bits, num_extra_constants))
    }

    fn eval_unfiltered(&self, vars: EvaluationVars<F, D>) -> Vec<F::Extension> {
        let mut constraints = Vec::with_capacity(self.num_constraints());

        for copy in 0..self.num_copies {
            let access_index = vars.local_wires[self.wire_access_index(copy)];
            let mut list_items = (0..self.vec_size())
                .map(|i| vars.local_wires[self.wire_list_item(i, copy)])
                .collect::<Vec<_>>();
            let claimed_element = vars.local_wires[self.wire_claimed_element(copy)];
            let bits = (0..self.bits)
                .map(|i| vars.local_wires[self.wire_bit(i, copy)])
                .collect::<Vec<_>>();

            // Assert that each bit wire value is indeed boolean.
            for &b in &bits {
                constraints.push(b * (b - F::Extension::ONE));
            }

            // Assert that the binary decomposition was correct.
            let reconstructed_index = bits
                .iter()
                .rev()
                .fold(F::Extension::ZERO, |acc, &b| acc.double() + b);
            constraints.push(reconstructed_index - access_index);

            // Repeatedly fold the list, selecting the left or right item from each pair based on
            // the corresponding bit.
            for b in bits {
                list_items = list_items
                    .iter()
                    .tuples()
                    .map(|(&x, &y)| x + b * (y - x))
                    .collect()
            }

            debug_assert_eq!(list_items.len(), 1);
            constraints.push(list_items[0] - claimed_element);
        }

        constraints.extend(
            (0..self.num_extra_constants)
                .map(|i| vars.local_constants[i] - vars.local_wires[self.wire_extra_constant(i)]),
        );

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
        self.wire_bit(self.bits - 1, self.num_copies - 1) + 1
    }

    fn num_constants(&self) -> usize {
        self.num_extra_constants
    }

    fn degree(&self) -> usize {
        self.bits + 1
    }

    fn num_constraints(&self) -> usize {
        let constraints_per_copy = self.bits + 2;
        self.num_copies * constraints_per_copy + self.num_extra_constants
    }

    fn extra_constant_wires(&self) -> Vec<(usize, usize)> {
        (0..self.num_extra_constants)
            .map(|i| (i, self.wire_extra_constant(i)))
            .collect()
    }
}

impl<F: RichField + Extendable<D>, const D: usize> PackedEvaluableBase<F, D>
    for RandomAccessGate<F, D>
{
    fn eval_unfiltered_base_packed<P: PackedField<Scalar = F>>(
        &self,
        vars: EvaluationVarsBasePacked<P>,
        mut yield_constr: StridedConstraintConsumer<P>,
    ) {
        for copy in 0..self.num_copies {
            let access_index = vars.local_wires[self.wire_access_index(copy)];
            let mut list_items = (0..self.vec_size())
                .map(|i| vars.local_wires[self.wire_list_item(i, copy)])
                .collect::<Vec<_>>();
            let claimed_element = vars.local_wires[self.wire_claimed_element(copy)];
            let bits = (0..self.bits)
                .map(|i| vars.local_wires[self.wire_bit(i, copy)])
                .collect::<Vec<_>>();

            // Assert that each bit wire value is indeed boolean.
            for &b in &bits {
                yield_constr.one(b * (b - F::ONE));
            }

            // Assert that the binary decomposition was correct.
            let reconstructed_index = bits.iter().rev().fold(P::ZEROS, |acc, &b| acc + acc + b);
            yield_constr.one(reconstructed_index - access_index);

            // Repeatedly fold the list, selecting the left or right item from each pair based on
            // the corresponding bit.
            for b in bits {
                list_items = list_items
                    .iter()
                    .tuples()
                    .map(|(&x, &y)| x + b * (y - x))
                    .collect()
            }

            debug_assert_eq!(list_items.len(), 1);
            yield_constr.one(list_items[0] - claimed_element);
        }
        yield_constr.many(
            (0..self.num_extra_constants)
                .map(|i| vars.local_constants[i] - vars.local_wires[self.wire_extra_constant(i)]),
        );
    }
}
