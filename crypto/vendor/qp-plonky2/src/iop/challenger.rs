//! Challenger implementations for Fiat-Shamir transcript.
//!
//! This module provides:
//! - `Challenger` - Re-exported from core, for native prover/verifier use
//! - `RecursiveChallenger` - For in-circuit recursive verification

#[cfg(not(feature = "std"))]
use alloc::{vec, vec::Vec};
use core::marker::PhantomData;

use plonky2_field::extension::Extendable;
// Re-export Challenger from core for use throughout plonky2
pub use qp_plonky2_core::Challenger;

use crate::hash::hash_types::{HashOutTarget, MerkleCapTarget, RichField};
use crate::hash::hashing::PlonkyPermutation;
use crate::iop::ext_target::ExtensionTarget;
use crate::iop::target::Target;
use crate::plonk::circuit_builder::CircuitBuilder;
use crate::plonk::config::AlgebraicHasher;

/// A recursive version of `Challenger`. The main difference is that `RecursiveChallenger`'s input
/// buffer can grow beyond `H::Permutation::RATE`. This is so that `observe_element` etc do not need access
/// to the `CircuitBuilder`.
#[derive(Debug)]
pub struct RecursiveChallenger<F: RichField + Extendable<D>, H: AlgebraicHasher<F>, const D: usize>
{
    sponge_state: H::AlgebraicPermutation,
    input_buffer: Vec<Target>,
    output_buffer: Vec<Target>,
    __: PhantomData<(F, H)>,
}

impl<F: RichField + Extendable<D>, H: AlgebraicHasher<F>, const D: usize>
    RecursiveChallenger<F, H, D>
{
    pub fn new(builder: &mut CircuitBuilder<F, D>) -> Self {
        let zero = builder.zero();
        Self {
            sponge_state: H::AlgebraicPermutation::new(core::iter::repeat(zero)),
            input_buffer: Vec::new(),
            output_buffer: Vec::new(),
            __: PhantomData,
        }
    }

    pub fn from_state(sponge_state: H::AlgebraicPermutation) -> Self {
        Self {
            sponge_state,
            input_buffer: vec![],
            output_buffer: vec![],
            __: PhantomData,
        }
    }

    pub fn observe_element(&mut self, target: Target) {
        // Any buffered outputs are now invalid, since they wouldn't reflect this input.
        self.output_buffer.clear();

        self.input_buffer.push(target);
    }

    pub fn observe_elements(&mut self, targets: &[Target]) {
        for &target in targets {
            self.observe_element(target);
        }
    }

    pub fn observe_hash(&mut self, hash: &HashOutTarget) {
        self.observe_elements(&hash.elements)
    }

    pub fn observe_cap(&mut self, cap: &MerkleCapTarget) {
        for hash in &cap.0 {
            self.observe_hash(hash)
        }
    }

    pub fn observe_extension_element(&mut self, element: ExtensionTarget<D>) {
        self.observe_elements(&element.0);
    }

    pub fn observe_extension_elements(&mut self, elements: &[ExtensionTarget<D>]) {
        for &element in elements {
            self.observe_extension_element(element);
        }
    }

    pub fn get_challenge(&mut self, builder: &mut CircuitBuilder<F, D>) -> Target {
        self.absorb_buffered_inputs(builder);

        if self.output_buffer.is_empty() {
            // Evaluate the permutation to produce `r` new outputs.
            self.sponge_state = builder.permute::<H>(self.sponge_state);
            self.output_buffer = self.sponge_state.squeeze().to_vec();
        }

        self.output_buffer
            .pop()
            .expect("Output buffer should be non-empty")
    }

    pub fn get_n_challenges(
        &mut self,
        builder: &mut CircuitBuilder<F, D>,
        n: usize,
    ) -> Vec<Target> {
        (0..n).map(|_| self.get_challenge(builder)).collect()
    }

    pub fn get_hash(&mut self, builder: &mut CircuitBuilder<F, D>) -> HashOutTarget {
        HashOutTarget {
            elements: [
                self.get_challenge(builder),
                self.get_challenge(builder),
                self.get_challenge(builder),
                self.get_challenge(builder),
            ],
        }
    }

    pub fn get_extension_challenge(
        &mut self,
        builder: &mut CircuitBuilder<F, D>,
    ) -> ExtensionTarget<D> {
        self.get_n_challenges(builder, D).try_into().unwrap()
    }

    pub fn get_n_extension_challenges(
        &mut self,
        builder: &mut CircuitBuilder<F, D>,
        n: usize,
    ) -> Vec<ExtensionTarget<D>> {
        (0..n)
            .map(|_| self.get_extension_challenge(builder))
            .collect()
    }

    /// Absorb any buffered inputs. After calling this, the input buffer will be empty, and the
    /// output buffer will be full.
    fn absorb_buffered_inputs(&mut self, builder: &mut CircuitBuilder<F, D>) {
        if self.input_buffer.is_empty() {
            return;
        }

        for input_chunk in self.input_buffer.chunks(H::AlgebraicPermutation::RATE) {
            // Overwrite the first r elements with the inputs. This differs from a standard sponge,
            // where we would xor or add in the inputs. This is a well-known variant, though,
            // sometimes called "overwrite mode".
            self.sponge_state.set_from_slice(input_chunk, 0);
            self.sponge_state = builder.permute::<H>(self.sponge_state);
        }

        self.output_buffer = self.sponge_state.squeeze().to_vec();

        self.input_buffer.clear();
    }

    pub fn compact(&mut self, builder: &mut CircuitBuilder<F, D>) -> H::AlgebraicPermutation {
        self.absorb_buffered_inputs(builder);
        self.output_buffer.clear();
        self.sponge_state
    }
}

#[cfg(test)]
#[cfg(feature = "rand")]
mod tests {
    #[cfg(not(feature = "std"))]
    use alloc::vec::Vec;

    use plonky2_field::types::Sample;

    use crate::iop::challenger::{Challenger, RecursiveChallenger};
    use crate::iop::generator::generate_partial_witness;
    use crate::iop::target::Target;
    use crate::iop::witness::{PartialWitness, Witness};
    use crate::plonk::circuit_builder::CircuitBuilder;
    use crate::plonk::circuit_data::CircuitConfig;
    use crate::plonk::config::{GenericConfig, PoseidonGoldilocksConfig};

    #[test]
    fn no_duplicate_challenges() {
        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;
        let mut challenger = Challenger::<F, <C as GenericConfig<D>>::InnerHasher>::new();
        let mut challenges = Vec::new();

        for i in 1..10 {
            challenges.extend(challenger.get_n_challenges(i));
            challenger.observe_element(F::rand());
        }

        let dedup_challenges = {
            let mut dedup = challenges.clone();
            dedup.dedup();
            dedup
        };
        assert_eq!(dedup_challenges, challenges);
    }

    /// Tests for consistency between `Challenger` and `RecursiveChallenger`.
    #[test]
    fn test_consistency() {
        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;

        // These are mostly arbitrary, but we want to test some rounds with enough inputs/outputs to
        // trigger multiple absorptions/squeezes.
        let num_inputs_per_round = [2, 5, 3];
        let num_outputs_per_round = [1, 2, 4];

        // Generate random input messages.
        let inputs_per_round: Vec<Vec<F>> = num_inputs_per_round
            .iter()
            .map(|&n| F::rand_vec(n))
            .collect();

        let mut challenger = Challenger::<F, <C as GenericConfig<D>>::InnerHasher>::new();
        let mut outputs_per_round: Vec<Vec<F>> = Vec::new();
        for (r, inputs) in inputs_per_round.iter().enumerate() {
            challenger.observe_elements(inputs);
            outputs_per_round.push(challenger.get_n_challenges(num_outputs_per_round[r]));
        }

        let config = CircuitConfig::standard_recursion_config();
        let mut builder = CircuitBuilder::<F, D>::new(config);
        let mut recursive_challenger =
            RecursiveChallenger::<F, <C as GenericConfig<D>>::InnerHasher, D>::new(&mut builder);
        let mut recursive_outputs_per_round: Vec<Vec<Target>> = Vec::new();
        for (r, inputs) in inputs_per_round.iter().enumerate() {
            recursive_challenger.observe_elements(&builder.constants(inputs));
            recursive_outputs_per_round.push(
                recursive_challenger.get_n_challenges(&mut builder, num_outputs_per_round[r]),
            );
        }
        let circuit = builder.build::<C>();
        let inputs = PartialWitness::new();
        let witness =
            generate_partial_witness(inputs, &circuit.prover_only, &circuit.common).unwrap();
        let recursive_output_values_per_round: Vec<Vec<F>> = recursive_outputs_per_round
            .iter()
            .map(|outputs| witness.get_targets(outputs))
            .collect();

        assert_eq!(outputs_per_round, recursive_output_values_per_round);
    }
}
