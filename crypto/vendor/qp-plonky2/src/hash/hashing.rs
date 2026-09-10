//! Concrete instantiation of a hash function.

#[cfg(not(feature = "std"))]
use alloc::vec;
#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

// Re-export core hashing types and functions
pub use qp_plonky2_core::hashing::{
    compress, hash_leaf, hash_leaf_p2, hash_n_to_hash_no_pad, hash_n_to_hash_no_pad_p2,
    hash_n_to_m_no_pad, PlonkyPermutation,
};

use crate::field::extension::Extendable;
use crate::gates::poseidon2::SPONGE_RATE;
use crate::hash::hash_types::{HashOutTarget, RichField, NUM_HASH_OUT_ELTS};
use crate::iop::target::Target;
use crate::plonk::circuit_builder::CircuitBuilder;
use crate::plonk::config::AlgebraicHasher;

impl<F: RichField + Extendable<D>, const D: usize> CircuitBuilder<F, D> {
    pub fn hash_n_to_hash_no_pad<H: AlgebraicHasher<F>>(
        &mut self,
        inputs: Vec<Target>,
    ) -> HashOutTarget {
        HashOutTarget::from_vec(self.hash_n_to_m_no_pad::<H>(inputs, NUM_HASH_OUT_ELTS))
    }

    pub fn hash_n_to_m_no_pad<H: AlgebraicHasher<F>>(
        &mut self,
        inputs: Vec<Target>,
        num_outputs: usize,
    ) -> Vec<Target> {
        let zero = self.zero();
        let mut state = H::AlgebraicPermutation::new(core::iter::repeat(zero));

        // Absorb all input chunks.
        for input_chunk in inputs.chunks(H::AlgebraicPermutation::RATE) {
            // Overwrite the first r elements with the inputs. This differs from a standard sponge,
            // where we would xor or add in the inputs. This is a well-known variant, though,
            // sometimes called "overwrite mode".
            state.set_from_slice(input_chunk, 0);
            state = self.permute::<H>(state);
        }

        // Squeeze until we have the desired number of outputs.
        let mut outputs = Vec::with_capacity(num_outputs);
        loop {
            for &s in state.squeeze() {
                outputs.push(s);
                if outputs.len() == num_outputs {
                    return outputs;
                }
            }
            state = self.permute::<H>(state);
        }
    }

    /// Poseidon2 variable length hashing (identical to CPU `hash_n_to_hash_no_pad_p2`).
    pub fn hash_n_to_hash_no_pad_p2<H: AlgebraicHasher<F>>(
        &mut self,
        inputs: Vec<Target>,
    ) -> HashOutTarget {
        let zero = self.zero();
        let one = self.one();

        // Start from all-zero state.
        let mut st = H::AlgebraicPermutation::new(core::iter::repeat(zero));

        if SPONGE_RATE == 0 {
            // Defensive
            return HashOutTarget::from_vec(vec![zero; NUM_HASH_OUT_ELTS]);
        }

        // Absorb input in SPONGE_RATE-sized chunks with additive absorption.
        let mut idx = 0usize;
        while idx < inputs.len() {
            let remaining = inputs.len() - idx;
            let take = remaining.min(SPONGE_RATE);

            // Build one block of length SPONGE_RATE.
            let mut blk = vec![zero; SPONGE_RATE];
            for i in 0..take {
                blk[i] = inputs[idx + i];
            }

            // If this is the final (possibly partial) block and it's not full,
            // append the single '1' delimiter then zero-fill the rest.
            if idx + take == inputs.len() && take < SPONGE_RATE {
                blk[take] = one;
            }

            // Additive absorption then permute.
            for i in 0..SPONGE_RATE {
                let sum = self.add(st.as_ref()[i], blk[i]);
                st.set_elt(sum, i);
            }
            st = self.permute::<H>(st);

            idx += take;
        }

        // If inputs were an exact multiple of SPONGE_RATE (including empty),
        // absorb one full padding block [1, 0, 0, 0].
        if inputs.len() % SPONGE_RATE == 0 {
            let mut blk = vec![zero; SPONGE_RATE];
            blk[0] = one;
            for i in 0..SPONGE_RATE {
                let sum = self.add(st.as_ref()[i], blk[i]);
                st.set_elt(sum, i);
            }
            st = self.permute::<H>(st);
        }

        // Squeeze NUM_HASH_OUT_ELTS elements from the current state (no extra permute).
        let outs = st.squeeze()[..NUM_HASH_OUT_ELTS].to_vec();
        HashOutTarget::from_vec(outs)
    }

    /// Domain-separated leaf hash for Merkle trees (in-circuit version).
    ///
    /// This sets `capacity[RATE] = 1` before hashing to distinguish leaf hashes from
    /// internal node hashes (two_to_one), preventing second-preimage attacks.
    /// The capacity-region placement is critical: two_to_one/compress always has
    /// zero capacity, so no grind on rate-region values can produce a collision.
    pub fn hash_leaf<H: AlgebraicHasher<F>>(&mut self, inputs: Vec<Target>) -> HashOutTarget {
        let zero = self.zero();

        // Place `len + 1` in the capacity region (index = RATE): the non-zero value
        // domain-separates leaves from internal nodes, and encoding the length makes the digest
        // injective in length so zero-suffixed leaves cannot collide. Mirrors native `hash_leaf`.
        let len_tag = self.constant(F::from_canonical_usize(inputs.len() + 1));
        let mut state = H::AlgebraicPermutation::new(core::iter::repeat(zero));
        state.set_elt(len_tag, H::AlgebraicPermutation::RATE);

        // Absorb all input chunks (overwrite mode, same as hash_n_to_m_no_pad)
        for input_chunk in inputs.chunks(H::AlgebraicPermutation::RATE) {
            state.set_from_slice(input_chunk, 0);
            state = self.permute::<H>(state);
        }

        HashOutTarget::from_vec(state.squeeze()[..NUM_HASH_OUT_ELTS].to_vec())
    }

    /// Domain-separated leaf hash for Merkle trees (in-circuit Poseidon2 version).
    ///
    /// This sets `capacity[RATE] = 1` before hashing to distinguish leaf hashes from
    /// internal node hashes (two_to_one), preventing second-preimage attacks.
    /// Uses Poseidon2's additive absorption and padding.
    pub fn hash_leaf_p2<H: AlgebraicHasher<F>>(&mut self, inputs: Vec<Target>) -> HashOutTarget {
        let zero = self.zero();
        let one = self.one();

        // Domain separator in capacity region (index = RATE)
        let mut st = H::AlgebraicPermutation::new(core::iter::repeat(zero));
        st.set_elt(one, SPONGE_RATE);

        if SPONGE_RATE == 0 {
            return HashOutTarget::from_vec(vec![zero; NUM_HASH_OUT_ELTS]);
        }

        // Absorb input in SPONGE_RATE-sized chunks with additive absorption
        let mut idx = 0usize;
        while idx < inputs.len() {
            let remaining = inputs.len() - idx;
            let take = remaining.min(SPONGE_RATE);

            let mut blk = vec![zero; SPONGE_RATE];
            for i in 0..take {
                blk[i] = inputs[idx + i];
            }

            // Append '1' delimiter if this is the final partial block
            if idx + take == inputs.len() && take < SPONGE_RATE {
                blk[take] = one;
            }

            // Additive absorption then permute
            for i in 0..SPONGE_RATE {
                let sum = self.add(st.as_ref()[i], blk[i]);
                st.set_elt(sum, i);
            }
            st = self.permute::<H>(st);

            idx += take;
        }

        // If inputs were an exact multiple of SPONGE_RATE (including empty),
        // absorb one full padding block [1, 0, 0, ...]
        if inputs.len() % SPONGE_RATE == 0 {
            let mut blk = vec![zero; SPONGE_RATE];
            blk[0] = one;
            for i in 0..SPONGE_RATE {
                let sum = self.add(st.as_ref()[i], blk[i]);
                st.set_elt(sum, i);
            }
            st = self.permute::<H>(st);
        }

        HashOutTarget::from_vec(st.squeeze()[..NUM_HASH_OUT_ELTS].to_vec())
    }
}
