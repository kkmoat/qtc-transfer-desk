//! Proof challenge types shared between prover and verifier.

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

use crate::field::extension::Extendable;
use crate::fri_structure::FriChallenges;
use crate::hash_types::RichField;

/// Challenges derived from the proof using Fiat-Shamir.
#[derive(Debug)]
pub struct ProofChallenges<F: RichField + Extendable<D>, const D: usize> {
    /// Random values used in Plonk's permutation argument.
    pub plonk_betas: Vec<F>,

    /// Random values used in Plonk's permutation argument.
    pub plonk_gammas: Vec<F>,

    /// Random values used to combine PLONK constraints.
    pub plonk_alphas: Vec<F>,

    /// Lookup challenges.
    pub plonk_deltas: Vec<F>,

    /// Point at which the PLONK polynomials are opened.
    pub plonk_zeta: F::Extension,

    /// FRI challenges.
    pub fri_challenges: FriChallenges<F, D>,
}

/// Coset elements that can be inferred in the FRI reduction steps.
pub struct FriInferredElements<F: RichField + Extendable<D>, const D: usize>(pub Vec<F::Extension>);
