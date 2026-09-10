//! FRI proof types.
//!
//! Re-exports base types from core and provides prover-specific Target types.

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

// Re-export all FRI proof types from core
pub use qp_plonky2_core::fri_proof::{
    CompressedFriProof, CompressedFriQueryRounds, FriInitialTreeProof, FriProof, FriQueryRound,
    FriQueryStep,
};
// Re-export FriChallenges from core
pub use qp_plonky2_core::FriChallenges;

use crate::gadgets::polynomial::PolynomialCoeffsExtTarget;
use crate::hash::hash_types::MerkleCapTarget;
use crate::hash::merkle_proofs::MerkleProofTarget;
use crate::iop::ext_target::ExtensionTarget;
use crate::iop::target::Target;
use crate::plonk::plonk_common::salt_size;

/// Target version of FriQueryStep for circuit building.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FriQueryStepTarget<const D: usize> {
    pub evals: Vec<ExtensionTarget<D>>,
    pub merkle_proof: MerkleProofTarget,
}

/// Target version of FriInitialTreeProof for circuit building.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FriInitialTreeProofTarget {
    pub evals_proofs: Vec<(Vec<Target>, MerkleProofTarget)>,
}

impl FriInitialTreeProofTarget {
    pub(crate) fn unsalted_eval(
        &self,
        oracle_index: usize,
        poly_index: usize,
        salted: bool,
    ) -> Target {
        self.unsalted_evals(oracle_index, salted)[poly_index]
    }

    fn unsalted_evals(&self, oracle_index: usize, salted: bool) -> &[Target] {
        let evals = &self.evals_proofs[oracle_index].0;
        &evals[..evals.len() - salt_size(salted)]
    }
}

/// Target version of FriQueryRound for circuit building.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FriQueryRoundTarget<const D: usize> {
    pub initial_trees_proof: FriInitialTreeProofTarget,
    pub steps: Vec<FriQueryStepTarget<D>>,
}

/// Target version of the disclosed final polynomial coefficients.
pub type FriFinalPolyTarget<const D: usize> = PolynomialCoeffsExtTarget<D>;

/// Target version of FriProof for circuit building.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FriProofTarget<const D: usize> {
    pub commit_phase_merkle_caps: Vec<MerkleCapTarget>,
    pub query_round_proofs: Vec<FriQueryRoundTarget<D>>,
    pub final_poly: FriFinalPolyTarget<D>,
    pub pow_witness: Target,
}

/// Target version of FriChallenges for circuit building.
#[derive(Debug)]
pub struct FriChallengesTarget<const D: usize> {
    pub fri_alpha: ExtensionTarget<D>,
    pub fri_betas: Vec<ExtensionTarget<D>>,
    pub fri_pow_response: Target,
    pub fri_query_indices: Vec<Target>,
}
