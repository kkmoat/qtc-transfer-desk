//! Hashing configuration to be used when building a circuit.
//!
//! This module defines a [`Hasher`] trait as well as its recursive
//! counterpart [`AlgebraicHasher`] for in-circuit hashing. It also
//! provides concrete configurations, one fully recursive leveraging
//! the Poseidon hash function both internally and natively, and one
//! mixing Poseidon internally and truncated Keccak externally.

// Re-export core config types - these are the canonical definitions
pub use qp_plonky2_core::config::{
    GenericConfig, GenericHashOut, Hasher, KeccakGoldilocksConfig, PoseidonGoldilocksConfig,
};

use crate::field::extension::Extendable;
use crate::hash::hash_types::{HashOut, RichField};
use crate::hash::hashing::PlonkyPermutation;
use crate::iop::target::{BoolTarget, Target};
use crate::plonk::circuit_builder::CircuitBuilder;

/// Trait for algebraic hash functions, built from a permutation using the sponge construction.
/// This extends the base `Hasher` trait with circuit-building capabilities.
pub trait AlgebraicHasher<F: RichField>: Hasher<F, Hash = HashOut<F>> {
    type AlgebraicPermutation: PlonkyPermutation<Target>;

    /// Circuit to conditionally swap two chunks of the inputs (useful in verifying Merkle proofs),
    /// then apply the permutation.
    fn permute_swapped<const D: usize>(
        inputs: Self::AlgebraicPermutation,
        swap: BoolTarget,
        builder: &mut CircuitBuilder<F, D>,
    ) -> Self::AlgebraicPermutation
    where
        F: RichField + Extendable<D>;
}
