//! Concrete instantiation of a hash function.
#[cfg(not(feature = "std"))]
use alloc::vec;
#[cfg(not(feature = "std"))]
use alloc::vec::Vec;
use core::fmt::Debug;

use crate::field::types::Field;
use crate::hash_types::{HashOut, RichField, NUM_HASH_OUT_ELTS};

/// Permutation that can be used in the sponge construction for an algebraic hash.
pub trait PlonkyPermutation<T: Copy + Default>:
    AsRef<[T]> + Copy + Debug + Default + Eq + Sync + Send
{
    const RATE: usize;
    const WIDTH: usize;

    /// Initialises internal state with values from `iter` until
    /// `iter` is exhausted or `Self::WIDTH` values have been
    /// received; remaining state (if any) initialised with
    /// `T::default()`. To initialise remaining elements with a
    /// different value, instead of your original `iter` pass
    /// `iter.chain(core::iter::repeat(F::from_canonical_u64(12345)))`
    /// or similar.
    fn new<I: IntoIterator<Item = T>>(iter: I) -> Self;

    /// Set idx-th state element to be `elt`. Panics if `idx >= WIDTH`.
    fn set_elt(&mut self, elt: T, idx: usize);

    /// Set state element `i` to be `elts[i] for i =
    /// start_idx..start_idx + n` where `n = min(elts.len(),
    /// WIDTH-start_idx)`. Panics if `start_idx > WIDTH`.
    fn set_from_iter<I: IntoIterator<Item = T>>(&mut self, elts: I, start_idx: usize);

    /// Same semantics as for `set_from_iter` but probably faster than
    /// just calling `set_from_iter(elts.iter())`.
    fn set_from_slice(&mut self, elts: &[T], start_idx: usize);

    /// Apply permutation to internal state
    fn permute(&mut self);

    /// Return a slice of `RATE` elements
    fn squeeze(&self) -> &[T];
}

/// A one-way compression function which takes two ~256 bit inputs and returns a ~256 bit output.
pub fn compress<F: Field, P: PlonkyPermutation<F>>(x: HashOut<F>, y: HashOut<F>) -> HashOut<F> {
    // TODO: With some refactoring, this function could be implemented as
    // hash_n_to_m_no_pad(chain(x.elements, y.elements), NUM_HASH_OUT_ELTS).

    debug_assert_eq!(x.elements.len(), NUM_HASH_OUT_ELTS);
    debug_assert_eq!(y.elements.len(), NUM_HASH_OUT_ELTS);
    debug_assert!(P::RATE >= NUM_HASH_OUT_ELTS);

    let mut perm = P::new(core::iter::repeat(F::ZERO));
    perm.set_from_slice(&x.elements, 0);
    perm.set_from_slice(&y.elements, NUM_HASH_OUT_ELTS);

    perm.permute();

    HashOut {
        elements: perm.squeeze()[..NUM_HASH_OUT_ELTS].try_into().unwrap(),
    }
}

/// Hash a message without any padding step. Note that this can enable length-extension attacks.
/// However, it is still collision-resistant in cases where the input has a fixed length.
pub fn hash_n_to_m_no_pad<F: RichField, P: PlonkyPermutation<F>>(
    inputs: &[F],
    num_outputs: usize,
) -> Vec<F> {
    let mut perm = P::new(core::iter::repeat(F::ZERO));

    // Absorb all input chunks.
    for input_chunk in inputs.chunks(P::RATE) {
        perm.set_from_slice(input_chunk, 0);
        perm.permute();
    }

    // Squeeze until we have the desired number of outputs.
    let mut outputs = Vec::new();
    loop {
        for &item in perm.squeeze() {
            outputs.push(item);
            if outputs.len() == num_outputs {
                return outputs;
            }
        }
        perm.permute();
    }
}

pub fn hash_n_to_hash_no_pad<F: RichField, P: PlonkyPermutation<F>>(inputs: &[F]) -> HashOut<F> {
    HashOut::from_vec(hash_n_to_m_no_pad::<F, P>(inputs, NUM_HASH_OUT_ELTS))
}

/// Appends a single `1` terminator and zero-fills to a multiple of `rate` (the `10*` rule).
///
/// The terminator's position encodes the input length, so inputs that differ only by trailing
/// zeros (e.g. `[a, b]` vs `[a, b, 0]`) produce distinct padded messages and cannot collide.
fn pad10_to_rate<F: RichField>(inputs: &[F], rate: usize) -> Vec<F> {
    let padded_len = ((inputs.len() + 1 + rate - 1) / rate) * rate;
    let mut msg = vec![F::ZERO; padded_len];
    msg[..inputs.len()].copy_from_slice(inputs);
    msg[inputs.len()] = F::ONE;
    msg
}

// The Poseidon2 sponge core, factored into the three steps the Lean model
// (`qp-plonky2/formal/Plonky2Spec/Sponge.lean`) is written in, with matching names.
// The Lean transcription is differentially tested against this path
// (`sponge_structure_matches_lean_model` in the constraint-exporter).

/// Additive absorption of one block onto the rate lanes: `state[i] += block[i]` for
/// `i < block.len()` (`≤ RATE`); capacity lanes are untouched. Mirrors `Sponge.lean`'s
/// `addBlock`.
fn add_block<F: RichField, P: PlonkyPermutation<F>>(perm: &mut P, block: &[F]) {
    for (i, &x) in block.iter().enumerate() {
        let si = perm.as_ref()[i];
        perm.set_elt(si + x, i);
    }
}

/// Absorb a (padded) message block by block, permuting after each `RATE`-block.
/// Mirrors `Sponge.lean`'s `absorbMsg`.
fn absorb_msg<F: RichField, P: PlonkyPermutation<F>>(perm: &mut P, msg: &[F]) {
    for block in msg.chunks(P::RATE) {
        add_block(perm, block);
        perm.permute();
    }
}

/// Squeeze the `NUM_HASH_OUT_ELTS`-felt digest: the first lanes of the rate, with no
/// trailing permute. Mirrors `Sponge.lean`'s `squeeze4`.
fn squeeze4<F: RichField, P: PlonkyPermutation<F>>(perm: &P) -> HashOut<F> {
    HashOut::from_vec(perm.squeeze()[..NUM_HASH_OUT_ELTS].to_vec())
}

/// Domain-separated leaf hash for Merkle trees.
///
/// This function hashes leaf data with a domain separator to prevent internal nodes
/// from being presented as leaves. The domain separator is placed in the capacity
/// region of the sponge state (index RATE), ensuring that:
/// - `hash_leaf([a,b,c,d,e,f,g,h])` ≠ `two_to_one([a,b,c,d], [e,f,g,h])`
///
/// This prevents attacks where an attacker constructs a fake leaf whose hash
/// equals an internal node hash. The capacity-region placement is critical:
/// `two_to_one`/`compress` always uses all-zero capacity, so no grind on
/// rate-region values can produce a collision.
pub fn hash_leaf<F: RichField, P: PlonkyPermutation<F>>(inputs: &[F]) -> HashOut<F> {
    let mut perm = P::new(core::iter::repeat(F::ZERO));

    // Place `len + 1` in the capacity region (index = RATE). The non-zero value domain-separates
    // leaves from internal `two_to_one`/`compress` nodes (which always use zero capacity), and
    // encoding the length makes the digest injective in length so distinct zero-suffixed leaves
    // (e.g. `[a,b,c,d,e]` vs `[a,b,c,d,e,0]`) cannot collide under overwrite-mode absorption.
    perm.set_elt(F::from_canonical_usize(inputs.len() + 1), P::RATE);

    // Absorb all input chunks (overwrite mode, same as hash_n_to_m_no_pad).
    for input_chunk in inputs.chunks(P::RATE) {
        perm.set_from_slice(input_chunk, 0);
        perm.permute();
    }

    HashOut {
        elements: perm.squeeze()[..NUM_HASH_OUT_ELTS].try_into().unwrap(),
    }
}

/// Poseidon2 variable length padding (…||1||0* to RATE)
pub fn hash_n_to_hash_no_pad_p2<F: RichField, P: PlonkyPermutation<F>>(inputs: &[F]) -> HashOut<F> {
    // `pad10`: append one '1' and zero-pad to a rate-aligned length. This automatically
    // adds a whole [1,0,...,0] block when inputs.len() % rate == 0 (incl. empty input).
    let msg = pad10_to_rate(inputs, P::RATE);

    // Absorb additively from the all-zero state, then squeeze (no trailing permute).
    let mut perm = P::new(core::iter::repeat(F::ZERO));
    absorb_msg(&mut perm, &msg);
    squeeze4(&perm)
}

/// Domain-separated leaf hash for Merkle trees (Poseidon2 variant).
///
/// This function hashes leaf data with a domain separator to prevent internal nodes
/// from being presented as leaves. Uses Poseidon2's additive absorption and padding,
/// with a domain separator in the capacity region.
pub fn hash_leaf_p2<F: RichField, P: PlonkyPermutation<F>>(inputs: &[F]) -> HashOut<F> {
    // `pad10`: append '1' then zeros to a rate-aligned length.
    let msg = pad10_to_rate(inputs, P::RATE);

    // Domain separator in capacity region (index = RATE).
    // two_to_one uses hash_no_pad which has zero capacity, so this is unforgeable.
    let mut perm = P::new(core::iter::repeat(F::ZERO));
    perm.set_elt(F::ONE, P::RATE);

    // Same additive absorb / squeeze as the plain sponge (the capacity separator aside).
    absorb_msg(&mut perm, &msg);
    squeeze4(&perm)
}
