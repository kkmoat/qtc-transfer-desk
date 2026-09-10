//! Core traits and types shared between plonky2 prover and verifier.
//!
//! This crate provides the foundational types and traits that both the
//! full plonky2 prover and the lightweight verifier depend on.

#![allow(clippy::too_many_arguments)]
#![allow(clippy::needless_range_loop)]
#![cfg_attr(not(feature = "std"), no_std)]

#[cfg(not(feature = "std"))]
pub extern crate alloc;

/// Re-export of `plonky2_field` for field types.
#[doc(inline)]
pub use plonky2_field as field;

// Core modules - order matters for dependencies
mod arch;
pub mod challenger;
pub mod circuit_config;
pub mod config;
pub mod fri;
pub mod fri_proof;
pub mod fri_structure;
pub mod fri_validate_shape;
pub mod fri_verifier;
pub mod hash;
pub mod hash_types;
pub mod hashing;
pub mod iop;
pub mod keccak;
pub mod merkle_proofs;
pub mod merkle_tree;
pub mod plonk;
pub mod plonk_common;
pub mod poseidon;
pub mod poseidon_crandall;
pub mod poseidon_goldilocks;
pub mod proof;
pub mod reducing;
pub mod selectors;
pub mod strided_view;
pub mod util;

// Re-export key types at crate root for convenience
pub use challenger::Challenger;
// Circuit and FRI configuration types
pub use circuit_config::CircuitConfig;
pub use config::{
    GenericConfig, GenericHashOut, Hasher, KeccakGoldilocksConfig, PoseidonGoldilocksConfig,
};
pub use fri::{
    FriChallenger, FriConfig, FriConfigObserve, FriParams, FriParamsObserve, FriReductionStrategy,
};
// FRI proof types
pub use fri_proof::{
    CompressedFriProof, CompressedFriQueryRounds, FriInitialTreeProof, FriProof, FriQueryRound,
    FriQueryStep,
};
pub use fri_structure::{
    FriBatchInfo, FriChallenges, FriCoefficient, FriInstanceInfo, FriOpeningBatch,
    FriOpeningExpression, FriOpeningTerm, FriOpenings, FriOracleInfo, FriPolynomialInfo,
};
pub use fri_validate_shape::{
    validate_batch_fri_proof_shape, validate_fri_initial_proof_shape, validate_fri_proof_shape,
};
pub use fri_verifier::{
    compute_evaluation, fri_combine_initial, fri_verify_proof_of_work, verify_fri_proof,
    PrecomputedReducedOpenings,
};
// Hash utilities
pub use hash::path_compression::{compress_merkle_proofs, decompress_merkle_proofs};
pub use hash_types::{BytesHash, HashOut, RichField, NUM_HASH_OUT_ELTS};
pub use hashing::PlonkyPermutation;
// IOP types
pub use iop::{
    flatten_target, unflatten_target, BoolTarget, ExtensionAlgebraTarget, ExtensionTarget,
    HashOutTarget, MerkleCapTarget, Target, Wire,
};
pub use keccak::{KeccakHash, KeccakPermutation};
pub use merkle_proofs::MerkleProof;
pub use merkle_tree::{
    capacity_up_to_mut, fill_digests_buf, fill_subtree, merkle_tree_prove, MerkleCap, MerkleTree,
};
pub use plonk_common::{
    eval_l_0, eval_zero_poly, reduce_with_powers, reduce_with_powers_multi, salt_size, PlonkOracle,
    SALT_SIZE,
};
pub use poseidon::{
    Permuter, Poseidon, PoseidonHash, PoseidonPermutation, ALL_ROUND_CONSTANTS, HALF_N_FULL_ROUNDS,
    N_FULL_ROUNDS_TOTAL, N_PARTIAL_ROUNDS, N_ROUNDS, SPONGE_CAPACITY, SPONGE_RATE, SPONGE_WIDTH,
};
// Proof challenge types
pub use proof::{FriInferredElements, ProofChallenges};
pub use selectors::{LookupSelectors, SelectorsInfo, UNUSED_SELECTOR};
// Utility functions
pub use util::{
    branch_hint, log2_ceil, log2_strict, reverse_bits, reverse_index_bits,
    reverse_index_bits_in_place,
};

/// The extension degree for the field extension (D=2 provides 100-bits of security)
pub const D: usize = 2;

/// The standard Plonky2 configuration using Poseidon hash over Goldilocks field
pub type C = PoseidonGoldilocksConfig;

/// The Goldilocks prime field
pub type F = field::goldilocks_field::GoldilocksField;
