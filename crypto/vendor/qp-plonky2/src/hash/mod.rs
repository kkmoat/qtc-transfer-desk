//! plonky2 hashing logic for in-circuit hashing and Merkle proof verification
//! as well as specific hash functions implementation.

pub mod batch_merkle_tree;
pub mod hash_types;
pub mod hashing;
pub mod keccak;
pub mod merkle_proofs;
pub mod merkle_tree;
pub mod path_compression;
pub mod poseidon;
pub mod poseidon2;

// Re-export poseidon_goldilocks from core (Poseidon impl for GoldilocksField)
// The implementation is in core since both Poseidon trait and GoldilocksField type
// are defined outside plonky2.
pub use qp_plonky2_core::poseidon_goldilocks;
