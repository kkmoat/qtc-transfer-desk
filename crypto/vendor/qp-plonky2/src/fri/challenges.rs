//! FRI challenge generation for Challenger.
//!
//! This module re-exports the FriChallenger trait from qp-plonky2-core
//! and provides additional circuit-based FRI challenge generation for RecursiveChallenger.

// Re-export FriChallenger trait from core
pub use qp_plonky2_core::FriChallenger;

use crate::field::extension::Extendable;
use crate::fri::proof::{FriChallengesTarget, FriFinalPolyTarget};
use crate::fri::structure::FriOpeningsTarget;
use crate::fri::FriConfig;
use crate::hash::hash_types::{MerkleCapTarget, RichField};
use crate::iop::challenger::RecursiveChallenger;
use crate::iop::target::Target;
use crate::plonk::circuit_builder::CircuitBuilder;
use crate::plonk::config::AlgebraicHasher;

impl<F: RichField + Extendable<D>, H: AlgebraicHasher<F>, const D: usize>
    RecursiveChallenger<F, H, D>
{
    pub fn observe_openings(&mut self, openings: &FriOpeningsTarget<D>) {
        for v in &openings.batches {
            self.observe_extension_elements(&v.values);
        }
    }

    pub fn fri_challenges(
        &mut self,
        builder: &mut CircuitBuilder<F, D>,
        commit_phase_merkle_caps: &[MerkleCapTarget],
        final_poly: &FriFinalPolyTarget<D>,
        pow_witness: Target,
        inner_fri_config: &FriConfig,
    ) -> FriChallengesTarget<D> {
        let num_fri_queries = inner_fri_config.num_query_rounds;
        // Scaling factor to combine polynomials.
        let fri_alpha = self.get_extension_challenge(builder);

        // Recover the random betas used in the FRI reductions.
        let fri_betas = commit_phase_merkle_caps
            .iter()
            .map(|cap| {
                self.observe_cap(cap);
                self.get_extension_challenge(builder)
            })
            .collect();

        self.observe_extension_elements(&final_poly.0);

        self.observe_element(pow_witness);
        let fri_pow_response = self.get_challenge(builder);

        let fri_query_indices = (0..num_fri_queries)
            .map(|_| self.get_challenge(builder))
            .collect();

        FriChallengesTarget {
            fri_alpha,
            fri_betas,
            fri_pow_response,
            fri_query_indices,
        }
    }
}
