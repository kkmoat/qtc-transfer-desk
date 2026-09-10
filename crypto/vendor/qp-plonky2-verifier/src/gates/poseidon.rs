#[cfg(not(feature = "std"))]
use alloc::{format, string::String, vec::Vec};
use core::marker::PhantomData;

use qp_plonky2_core::poseidon;
use qp_plonky2_core::poseidon::{Poseidon, SPONGE_WIDTH};

use crate::field::extension::Extendable;
use crate::field::types::Field;
use crate::gates::gate::VerificationGate;
use crate::gates::util::StridedConstraintConsumer;
use crate::hash::hash_types::RichField;
use crate::plonk::circuit_data::CommonCircuitData;
use crate::plonk::vars::{EvaluationVars, EvaluationVarsBase};
use crate::util::serialization::{Buffer, IoResult};

/// Evaluates a full Poseidon permutation with 12 state elements.
///
/// This also has some extra features to make it suitable for efficiently verifying Merkle proofs.
/// It has a flag which can be used to swap the first four inputs with the next four, for ordering
/// sibling digests.
#[derive(Debug, Default)]
pub struct PoseidonGate<F: RichField + Extendable<D>, const D: usize>(PhantomData<F>);

impl<F: RichField + Extendable<D>, const D: usize> PoseidonGate<F, D> {
    pub const fn new() -> Self {
        Self(PhantomData)
    }

    /// The wire index for the `i`th input to the permutation.
    pub(crate) const fn wire_input(i: usize) -> usize {
        i
    }

    /// The wire index for the `i`th output to the permutation.
    pub(crate) const fn wire_output(i: usize) -> usize {
        SPONGE_WIDTH + i
    }

    /// If this is set to 1, the first four inputs will be swapped with the next four inputs. This
    /// is useful for ordering hashes in Merkle proofs. Otherwise, this should be set to 0.
    pub(crate) const WIRE_SWAP: usize = 2 * SPONGE_WIDTH;

    const START_DELTA: usize = 2 * SPONGE_WIDTH + 1;

    /// A wire which stores `swap * (input[i + 4] - input[i])`; used to compute the swapped inputs.
    const fn wire_delta(i: usize) -> usize {
        assert!(i < 4);
        Self::START_DELTA + i
    }

    const START_FULL_0: usize = Self::START_DELTA + 4;

    /// A wire which stores the input of the `i`-th S-box of the `round`-th round of the first set
    /// of full rounds.
    const fn wire_full_sbox_0(round: usize, i: usize) -> usize {
        debug_assert!(
            round != 0,
            "First round S-box inputs are not stored as wires"
        );
        debug_assert!(round < poseidon::HALF_N_FULL_ROUNDS);
        debug_assert!(i < SPONGE_WIDTH);
        Self::START_FULL_0 + SPONGE_WIDTH * (round - 1) + i
    }

    const START_PARTIAL: usize =
        Self::START_FULL_0 + SPONGE_WIDTH * (poseidon::HALF_N_FULL_ROUNDS - 1);

    /// A wire which stores the input of the S-box of the `round`-th round of the partial rounds.
    const fn wire_partial_sbox(round: usize) -> usize {
        debug_assert!(round < poseidon::N_PARTIAL_ROUNDS);
        Self::START_PARTIAL + round
    }

    const START_FULL_1: usize = Self::START_PARTIAL + poseidon::N_PARTIAL_ROUNDS;

    /// A wire which stores the input of the `i`-th S-box of the `round`-th round of the second set
    /// of full rounds.
    const fn wire_full_sbox_1(round: usize, i: usize) -> usize {
        debug_assert!(round < poseidon::HALF_N_FULL_ROUNDS);
        debug_assert!(i < SPONGE_WIDTH);
        Self::START_FULL_1 + SPONGE_WIDTH * round + i
    }

    /// End of wire indices, exclusive.
    const fn end() -> usize {
        Self::START_FULL_1 + SPONGE_WIDTH * poseidon::HALF_N_FULL_ROUNDS
    }
}

impl<F: RichField + Extendable<D>, const D: usize> VerificationGate<F, D> for PoseidonGate<F, D> {
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
        Ok(PoseidonGate::new())
    }

    fn eval_unfiltered(&self, vars: EvaluationVars<F, D>) -> Vec<F::Extension> {
        let mut constraints = Vec::with_capacity(self.num_constraints());

        // Assert that `swap` is binary.
        let swap = vars.local_wires[Self::WIRE_SWAP];
        constraints.push(swap * (swap - F::Extension::ONE));

        // Assert that each delta wire is set properly: `delta_i = swap * (rhs - lhs)`.
        for i in 0..4 {
            let input_lhs = vars.local_wires[Self::wire_input(i)];
            let input_rhs = vars.local_wires[Self::wire_input(i + 4)];
            let delta_i = vars.local_wires[Self::wire_delta(i)];
            constraints.push(swap * (input_rhs - input_lhs) - delta_i);
        }

        // Compute the possibly-swapped input layer.
        let mut state = [F::Extension::ZERO; SPONGE_WIDTH];
        for i in 0..4 {
            let delta_i = vars.local_wires[Self::wire_delta(i)];
            let input_lhs = Self::wire_input(i);
            let input_rhs = Self::wire_input(i + 4);
            state[i] = vars.local_wires[input_lhs] + delta_i;
            state[i + 4] = vars.local_wires[input_rhs] - delta_i;
        }
        for i in 8..SPONGE_WIDTH {
            state[i] = vars.local_wires[Self::wire_input(i)];
        }

        let mut round_ctr = 0;

        // First set of full rounds.
        for r in 0..poseidon::HALF_N_FULL_ROUNDS {
            <F as Poseidon>::constant_layer_field(&mut state, round_ctr);
            if r != 0 {
                for i in 0..SPONGE_WIDTH {
                    let sbox_in = vars.local_wires[Self::wire_full_sbox_0(r, i)];
                    constraints.push(state[i] - sbox_in);
                    state[i] = sbox_in;
                }
            }
            <F as Poseidon>::sbox_layer_field(&mut state);
            state = <F as Poseidon>::mds_layer_field(&state);
            round_ctr += 1;
        }

        // Partial rounds.
        <F as Poseidon>::partial_first_constant_layer(&mut state);
        state = <F as Poseidon>::mds_partial_layer_init(&state);
        for r in 0..(poseidon::N_PARTIAL_ROUNDS - 1) {
            let sbox_in = vars.local_wires[Self::wire_partial_sbox(r)];
            constraints.push(state[0] - sbox_in);
            state[0] = <F as Poseidon>::sbox_monomial(sbox_in);
            state[0] +=
                F::Extension::from_canonical_u64(<F as Poseidon>::FAST_PARTIAL_ROUND_CONSTANTS[r]);
            state = <F as Poseidon>::mds_partial_layer_fast_field(&state, r);
        }
        let sbox_in = vars.local_wires[Self::wire_partial_sbox(poseidon::N_PARTIAL_ROUNDS - 1)];
        constraints.push(state[0] - sbox_in);
        state[0] = <F as Poseidon>::sbox_monomial(sbox_in);
        state =
            <F as Poseidon>::mds_partial_layer_fast_field(&state, poseidon::N_PARTIAL_ROUNDS - 1);
        round_ctr += poseidon::N_PARTIAL_ROUNDS;

        // Second set of full rounds.
        for r in 0..poseidon::HALF_N_FULL_ROUNDS {
            <F as Poseidon>::constant_layer_field(&mut state, round_ctr);
            for i in 0..SPONGE_WIDTH {
                let sbox_in = vars.local_wires[Self::wire_full_sbox_1(r, i)];
                constraints.push(state[i] - sbox_in);
                state[i] = sbox_in;
            }
            <F as Poseidon>::sbox_layer_field(&mut state);
            state = <F as Poseidon>::mds_layer_field(&state);
            round_ctr += 1;
        }

        for i in 0..SPONGE_WIDTH {
            constraints.push(state[i] - vars.local_wires[Self::wire_output(i)]);
        }

        constraints
    }

    fn eval_unfiltered_base_one(
        &self,
        vars: EvaluationVarsBase<F>,
        mut yield_constr: StridedConstraintConsumer<F>,
    ) {
        // Assert that `swap` is binary.
        let swap = vars.local_wires[Self::WIRE_SWAP];
        yield_constr.one(swap * swap.sub_one());

        // Assert that each delta wire is set properly: `delta_i = swap * (rhs - lhs)`.
        for i in 0..4 {
            let input_lhs = vars.local_wires[Self::wire_input(i)];
            let input_rhs = vars.local_wires[Self::wire_input(i + 4)];
            let delta_i = vars.local_wires[Self::wire_delta(i)];
            yield_constr.one(swap * (input_rhs - input_lhs) - delta_i);
        }

        // Compute the possibly-swapped input layer.
        let mut state = [F::ZERO; SPONGE_WIDTH];
        for i in 0..4 {
            let delta_i = vars.local_wires[Self::wire_delta(i)];
            let input_lhs = Self::wire_input(i);
            let input_rhs = Self::wire_input(i + 4);
            state[i] = vars.local_wires[input_lhs] + delta_i;
            state[i + 4] = vars.local_wires[input_rhs] - delta_i;
        }
        for i in 8..SPONGE_WIDTH {
            state[i] = vars.local_wires[Self::wire_input(i)];
        }

        let mut round_ctr = 0;

        // First set of full rounds.
        for r in 0..poseidon::HALF_N_FULL_ROUNDS {
            <F as Poseidon>::constant_layer(&mut state, round_ctr);
            if r != 0 {
                for i in 0..SPONGE_WIDTH {
                    let sbox_in = vars.local_wires[Self::wire_full_sbox_0(r, i)];
                    yield_constr.one(state[i] - sbox_in);
                    state[i] = sbox_in;
                }
            }
            <F as Poseidon>::sbox_layer(&mut state);
            state = <F as Poseidon>::mds_layer(&state);
            round_ctr += 1;
        }

        // Partial rounds.
        <F as Poseidon>::partial_first_constant_layer(&mut state);
        state = <F as Poseidon>::mds_partial_layer_init(&state);
        for r in 0..(poseidon::N_PARTIAL_ROUNDS - 1) {
            let sbox_in = vars.local_wires[Self::wire_partial_sbox(r)];
            yield_constr.one(state[0] - sbox_in);
            state[0] = <F as Poseidon>::sbox_monomial(sbox_in);
            state[0] += F::from_canonical_u64(<F as Poseidon>::FAST_PARTIAL_ROUND_CONSTANTS[r]);
            state = <F as Poseidon>::mds_partial_layer_fast(&state, r);
        }
        let sbox_in = vars.local_wires[Self::wire_partial_sbox(poseidon::N_PARTIAL_ROUNDS - 1)];
        yield_constr.one(state[0] - sbox_in);
        state[0] = <F as Poseidon>::sbox_monomial(sbox_in);
        state = <F as Poseidon>::mds_partial_layer_fast(&state, poseidon::N_PARTIAL_ROUNDS - 1);
        round_ctr += poseidon::N_PARTIAL_ROUNDS;

        // Second set of full rounds.
        for r in 0..poseidon::HALF_N_FULL_ROUNDS {
            <F as Poseidon>::constant_layer(&mut state, round_ctr);
            for i in 0..SPONGE_WIDTH {
                let sbox_in = vars.local_wires[Self::wire_full_sbox_1(r, i)];
                yield_constr.one(state[i] - sbox_in);
                state[i] = sbox_in;
            }
            <F as Poseidon>::sbox_layer(&mut state);
            state = <F as Poseidon>::mds_layer(&state);
            round_ctr += 1;
        }

        for i in 0..SPONGE_WIDTH {
            yield_constr.one(state[i] - vars.local_wires[Self::wire_output(i)]);
        }
    }

    fn num_wires(&self) -> usize {
        Self::end()
    }

    fn num_constants(&self) -> usize {
        0
    }

    fn degree(&self) -> usize {
        7
    }

    fn num_constraints(&self) -> usize {
        SPONGE_WIDTH * (poseidon::N_FULL_ROUNDS_TOTAL - 1)
            + poseidon::N_PARTIAL_ROUNDS
            + SPONGE_WIDTH
            + 1
            + 4
    }
}
