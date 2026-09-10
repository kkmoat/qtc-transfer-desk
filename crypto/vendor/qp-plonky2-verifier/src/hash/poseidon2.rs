#![allow(clippy::needless_range_loop)]

extern crate alloc;

#[cfg(not(feature = "std"))]
use core::fmt::Debug;

use once_cell::sync::Lazy;
// We only support Goldilocks for now, which matches your Poseidon2Core.
use plonky2_field::goldilocks_field::GoldilocksField as GL;
use qp_plonky2_core::hashing::{hash_leaf_p2, hash_n_to_hash_no_pad_p2, PlonkyPermutation};
use qp_poseidon_core::{Goldilocks as QpG, Poseidon2, SPONGE_RATE, SPONGE_WIDTH};

use crate::field::types::{Field, PrimeField64};
use crate::hash::hash_types::{HashOut, RichField, NUM_HASH_OUT_ELTS};
use crate::plonk::config::Hasher;

/// Static Poseidon2 instance, initialized once and reused across all calls.
/// The instance is determined entirely by compile-time constants and is safe to share.
static POSEIDON2: Lazy<Poseidon2> = Lazy::new(Poseidon2::new);

/// ---------- Internal helper: qp-poseidon-core permutation on Goldilocks ----------
#[inline(always)]
fn p2_permute_gl(mut state: [GL; SPONGE_WIDTH]) -> [GL; SPONGE_WIDTH] {
    // Convert to qp-poseidon-core Goldilocks.
    let mut s_qp = [QpG::ZERO; SPONGE_WIDTH];
    for i in 0..SPONGE_WIDTH {
        // GL -> u64 -> QpG (both mod 2^64 - 2^32 + 1)
        s_qp[i] = QpG::new(state[i].to_canonical_u64());
    }

    POSEIDON2.permute_mut(&mut s_qp);

    // Back to plonky2 GL
    for i in 0..SPONGE_WIDTH {
        state[i] = GL::from_noncanonical_u64(s_qp[i].as_canonical_u64());
    }
    state
}

// ---------- Permuter wiring ----------
pub trait P2Permuter: Sized {
    fn permute(input: [Self; SPONGE_WIDTH]) -> [Self; SPONGE_WIDTH];
}

// CPU: use the canonical p3 Poseidon2 GL permutation.
impl P2Permuter for GL {
    #[inline(always)]
    fn permute(input: [Self; SPONGE_WIDTH]) -> [Self; SPONGE_WIDTH] {
        p2_permute_gl(input)
    }
}

// ---------- PlonkyPermutation wrapper ----------
#[derive(Copy, Clone, Default, Debug, PartialEq)]
pub struct Poseidon2Permutation<T> {
    state: [T; SPONGE_WIDTH],
}

impl<T: Eq> Eq for Poseidon2Permutation<T> {}

impl<T> AsRef<[T]> for Poseidon2Permutation<T> {
    fn as_ref(&self) -> &[T] {
        &self.state
    }
}

impl<T: Default + Copy> Poseidon2Permutation<T> {
    #[inline(always)]
    fn new_blank() -> Self {
        Self {
            state: [T::default(); SPONGE_WIDTH],
        }
    }
}

impl<T: Copy + core::fmt::Debug + Default + Eq + P2Permuter + Send + Sync> PlonkyPermutation<T>
    for Poseidon2Permutation<T>
{
    const RATE: usize = SPONGE_RATE;
    const WIDTH: usize = SPONGE_WIDTH;

    fn new<I: IntoIterator<Item = T>>(elts: I) -> Self {
        let mut perm = Self::new_blank();
        perm.set_from_iter(elts, 0);
        perm
    }

    fn set_elt(&mut self, elt: T, idx: usize) {
        self.state[idx] = elt;
    }

    fn set_from_iter<I: IntoIterator<Item = T>>(&mut self, elts: I, start_idx: usize) {
        for (s, e) in self.state[start_idx..].iter_mut().zip(elts) {
            *s = e;
        }
    }

    fn set_from_slice(&mut self, elts: &[T], start_idx: usize) {
        let end = start_idx + elts.len();
        self.state[start_idx..end].copy_from_slice(elts);
    }

    fn permute(&mut self) {
        self.state = T::permute(self.state);
    }

    fn squeeze(&self) -> &[T] {
        &self.state[..Self::RATE]
    }
}

// ---------- Hasher (CPU) ----------
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct Poseidon2Hash;

impl<F: RichField + P2Permuter> Hasher<F> for Poseidon2Hash {
    const HASH_SIZE: usize = NUM_HASH_OUT_ELTS * 8; // 4 * 8 = 32 bytes
    type Hash = HashOut<F>;
    type Permutation = Poseidon2Permutation<F>;

    fn hash_no_pad(input: &[F]) -> Self::Hash {
        hash_n_to_hash_no_pad_p2::<F, Self::Permutation>(input)
    }

    fn hash_leaf(input: &[F]) -> Self::Hash {
        hash_leaf_p2::<F, Self::Permutation>(input)
    }

    /// Keep CPU equivalence: concatenate 8 felts and call the same `hash_no_pad`.
    fn two_to_one(left: Self::Hash, right: Self::Hash) -> Self::Hash {
        let mut input = [F::ZERO; 2 * NUM_HASH_OUT_ELTS];
        input[..NUM_HASH_OUT_ELTS].copy_from_slice(&left.elements);
        input[NUM_HASH_OUT_ELTS..].copy_from_slice(&right.elements);
        Self::hash_no_pad(&input)
    }
}

#[cfg(test)]
mod tests {
    extern crate alloc;
    use alloc::vec::Vec;

    use plonky2_field::types::Field;

    use super::*;

    /// Verify that the verifier's Poseidon2 hash matches the prover's.
    #[test]
    fn verifier_poseidon2_matches_prover() {
        use plonky2::hash::poseidon2::Poseidon2Hash as ProverPoseidon2Hash;
        use plonky2::plonk::config::Hasher as ProverHasher;

        // Test various input lengths to exercise padding logic
        let test_lengths = [0, 1, 2, 3, 4, 5, 7, 8, 9, 12, 15, 16, 17, 32];

        for len in test_lengths {
            let input: Vec<GL> = (0..len)
                .map(|i| GL::from_canonical_u64(i as u64 + 1))
                .collect();

            let verifier_hash = Poseidon2Hash::hash_no_pad(&input);
            let prover_hash = ProverPoseidon2Hash::hash_no_pad(&input);

            assert_eq!(
                verifier_hash, prover_hash,
                "Hash mismatch for input length {}!\n  Verifier: {:?}\n  Prover:   {:?}",
                len, verifier_hash.elements, prover_hash.elements
            );
        }
    }

    /// Test that RATE constant matches between verifier and prover
    #[test]
    fn verifier_rate_matches_prover() {
        use plonky2::hash::poseidon2::Poseidon2Permutation as ProverPerm;
        use qp_plonky2_core::hashing::PlonkyPermutation;

        assert_eq!(
            <Poseidon2Permutation<GL> as PlonkyPermutation<GL>>::RATE,
            <ProverPerm<GL> as PlonkyPermutation<GL>>::RATE,
            "RATE mismatch between verifier and prover!"
        );

        assert_eq!(
            <Poseidon2Permutation<GL> as PlonkyPermutation<GL>>::WIDTH,
            <ProverPerm<GL> as PlonkyPermutation<GL>>::WIDTH,
            "WIDTH mismatch between verifier and prover!"
        );
    }
}
