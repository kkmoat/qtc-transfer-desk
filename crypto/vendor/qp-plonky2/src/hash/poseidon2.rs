#![allow(clippy::needless_range_loop)]

extern crate alloc;

#[cfg(not(feature = "std"))]
use alloc::vec;
#[cfg(not(feature = "std"))]
use core::fmt::Debug;

use once_cell::sync::Lazy;
use plonky2_field::extension::Extendable;
// We only support Goldilocks for now, which matches your Poseidon2Core.
use plonky2_field::goldilocks_field::GoldilocksField as GL;
use qp_poseidon_core::{Goldilocks as QpG, Poseidon2, SPONGE_RATE, SPONGE_WIDTH};

use crate::field::types::{Field, PrimeField64};
use crate::gates::poseidon2::Poseidon2Gate;
use crate::hash::hash_types::{HashOut, RichField, NUM_HASH_OUT_ELTS};
use crate::hash::hashing::{hash_leaf_p2, hash_n_to_hash_no_pad_p2, PlonkyPermutation};
use crate::iop::target::{BoolTarget, Target};
use crate::plonk::circuit_builder::CircuitBuilder;
use crate::plonk::config::{AlgebraicHasher, Hasher};

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

// Targets: must go through AlgebraicHasher::permute_swapped (the gate); never call permute().
impl P2Permuter for Target {
    fn permute(_input: [Self; SPONGE_WIDTH]) -> [Self; SPONGE_WIDTH] {
        panic!("Call `permute_swapped()` instead of `permute()`");
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

#[allow(dead_code)]
pub fn hash_no_pad_bytes(input: &[GL]) -> [u8; 32] {
    let h = Poseidon2Hash::hash_no_pad(input);
    let mut out = [0u8; 32];
    // Little-endian u64 per felt, concatenated.
    for (i, elt) in h.elements.iter().enumerate() {
        let w = elt.to_canonical_u64().to_le_bytes();
        out[i * 8..(i + 1) * 8].copy_from_slice(&w);
    }
    out
}

// ---------- AlgebraicHasher (in-circuit) ----------
impl<F: RichField + P2Permuter> AlgebraicHasher<F> for Poseidon2Hash {
    type AlgebraicPermutation = Poseidon2Permutation<Target>;

    fn permute_swapped<const D: usize>(
        inputs: Self::AlgebraicPermutation,
        _swap: BoolTarget, // still ignored (semantics unchanged)
        b: &mut CircuitBuilder<F, D>,
    ) -> Self::AlgebraicPermutation
    where
        F: RichField + Extendable<D>,
    {
        let gate_type = Poseidon2Gate::<F, D>::new();
        let row = b.add_gate(gate_type, vec![]);

        let inp = inputs.as_ref();
        assert_eq!(inp.len(), SPONGE_WIDTH);

        // connect inputs
        for i in 0..SPONGE_WIDTH {
            b.connect(
                inp[i],
                Target::wire(row, Poseidon2Gate::<F, D>::wire_input(i)),
            );
        }

        // collect outputs
        let state: [Target; SPONGE_WIDTH] =
            core::array::from_fn(|i| Target::wire(row, Poseidon2Gate::<F, D>::wire_output(i)));

        Poseidon2Permutation { state }
    }
}

#[cfg(test)]
mod tests {
    use plonky2_field::goldilocks_field::GoldilocksField as F;
    use qp_poseidon_core::{hash_to_bytes, Goldilocks as QpF};
    use rand::rngs::ChaCha8Rng;
    use rand::{RngExt, SeedableRng};

    use super::*;
    use crate::iop::witness::{PartialWitness, WitnessWrite};
    use crate::plonk::circuit_builder::CircuitBuilder;
    use crate::plonk::circuit_data::CircuitConfig;
    use crate::plonk::config::PoseidonGoldilocksConfig;

    type C = PoseidonGoldilocksConfig;
    const D: usize = 2;

    /// Helper: build a circuit that hashes `inputs` in-circuit with Poseidon2,
    /// and constrain it to match the CPU result.
    fn assert_hash_matches(inputs: Vec<F>) {
        // --- CPU reference ---
        let cpu = Poseidon2Hash::hash_no_pad(&inputs);

        // --- Build circuit ---
        let mut builder = CircuitBuilder::<F, D>::new(CircuitConfig::standard_recursion_config());

        // Add virtual targets for all input elements.
        let ts: Vec<Target> = inputs
            .iter()
            .map(|_| builder.add_virtual_target())
            .collect();

        // In-circuit Poseidon2 additive-absorption hash.
        let out_t = builder.hash_n_to_hash_no_pad_p2::<Poseidon2Hash>(ts.clone());

        // Constrain circuit outputs to equal the CPU digest.
        for i in 0..NUM_HASH_OUT_ELTS {
            let c = builder.constant(cpu.elements[i]);
            builder.connect(out_t.elements[i], c);
        }

        let data = builder.build::<C>();

        // Set the witness for the inputs and prove+verify.
        let mut pw = PartialWitness::new();
        for (t, v) in ts.into_iter().zip(inputs.into_iter()) {
            pw.set_target(t, v).expect("setting target failed");
        }
        let proof = data.prove(pw).unwrap();
        data.verify(proof).unwrap();
    }

    #[test]
    fn poseidon2_hash_matches_cpu_edge_lengths() {
        // Exercise the padding logic carefully: empty, short, full blocks, and beyond.
        // RATE = 8, so we test boundaries around multiples of 8:
        // - 0: empty (needs full padding block)
        // - 1,2,3,4: small values
        // - 7,8,9: around 1×RATE boundary
        // - 15,16,17: around 2×RATE boundary
        // - 23,24,25: around 3×RATE boundary
        let lens: [usize; 14] = [0, 1, 2, 3, 4, 7, 8, 9, 15, 16, 17, 23, 24, 25];
        let mut rng = ChaCha8Rng::seed_from_u64(0xC0FFEE);

        for &len in &lens {
            let inputs: Vec<F> = (0..len)
                .map(|_| F::from_canonical_u64(rng.random()))
                .collect();
            assert_hash_matches(inputs);
        }
    }

    #[test]
    fn poseidon2_hash_matches_cpu_random_cases() {
        // A bunch of random lengths & values.
        let mut rng = ChaCha8Rng::seed_from_u64(0xFACEFEED);
        for _ in 0..20 {
            let len = (rng.random::<u32>() as usize) % 64; // up to 63 elements
            let inputs: Vec<F> = (0..len)
                .map(|_| F::from_canonical_u64(rng.random()))
                .collect();
            assert_hash_matches(inputs);
        }
    }
    #[test]
    fn poseidon2_hash_matches_qp_poseidon() {
        // random inputs of varying sizes
        let mut rng = ChaCha8Rng::seed_from_u64(0xD1CE_D00D);
        for _ in 0..100 {
            let len = (rng.random::<u32>() as usize) % 64; // up to 63 elements

            // Build the same input in both field types
            let inputs_f: Vec<F> = (0..len)
                .map(|_| F::from_canonical_u64(rng.random()))
                .collect();

            let inputs_qp: Vec<QpF> = inputs_f
                .iter()
                .map(|x| QpF::new(x.to_canonical_u64()))
                .collect();

            // Plonky2 CPU reference
            let cpu = Poseidon2Hash::hash_no_pad(&inputs_f);
            // Convert to bytes (LE u64 per felt, total 32 bytes)
            let mut cpu_bytes = [0u8; 32];
            for (i, elt) in cpu.elements.iter().enumerate() {
                let w = elt.to_canonical_u64().to_le_bytes();
                cpu_bytes[i * 8..(i + 1) * 8].copy_from_slice(&w);
            }

            // qp-poseidon-core reference
            let qp_bytes = hash_to_bytes(&inputs_qp);

            assert_eq!(cpu_bytes, qp_bytes, "Poseidon2 mismatch for len={len}");
        }
    }
}
