#[cfg(not(feature = "std"))]
use alloc::vec::Vec;
use core::mem::MaybeUninit;
use core::slice;

use plonky2_util::log2_strict;
use serde::{Deserialize, Serialize};

use crate::config::{GenericHashOut, Hasher};
use crate::hash_types::RichField;
use crate::merkle_proofs::MerkleProof;

/// The Merkle cap of height `h` of a Merkle tree is the `h`-th layer (from the root) of the tree.
/// It can be used in place of the root to verify Merkle paths, which are `h` elements shorter.
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(bound = "")]
// TODO: Change H to GenericHashOut<F>, since this only cares about the hash, not the hasher.
pub struct MerkleCap<F: RichField, H: Hasher<F>>(pub Vec<H::Hash>);

impl<F: RichField, H: Hasher<F>> Default for MerkleCap<F, H> {
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl<F: RichField, H: Hasher<F>> MerkleCap<F, H> {
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn height(&self) -> usize {
        log2_strict(self.len())
    }

    pub fn flatten(&self) -> Vec<F> {
        self.0.iter().flat_map(|&h| h.to_vec()).collect()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MerkleTree<F: RichField, H: Hasher<F>> {
    /// The data in the leaves of the Merkle tree.
    pub leaves: Vec<Vec<F>>,

    /// The digests in the tree. Consists of `cap.len()` sub-trees, each corresponding to one
    /// element in `cap`. Each subtree is contiguous and located at
    /// `digests[digests.len() / cap.len() * i..digests.len() / cap.len() * (i + 1)]`.
    /// Within each subtree, siblings are stored next to each other. The layout is,
    /// left_child_subtree || left_child_digest || right_child_digest || right_child_subtree, where
    /// left_child_digest and right_child_digest are H::Hash and left_child_subtree and
    /// right_child_subtree recurse. Observe that the digest of a node is stored by its _parent_.
    /// Consequently, the digests of the roots are not stored here (they can be found in `cap`).
    pub digests: Vec<H::Hash>,

    /// The Merkle cap.
    pub cap: MerkleCap<F, H>,
}

impl<F: RichField, H: Hasher<F>> Default for MerkleTree<F, H> {
    fn default() -> Self {
        Self {
            leaves: Vec::new(),
            digests: Vec::new(),
            cap: MerkleCap::default(),
        }
    }
}

pub fn capacity_up_to_mut<T>(v: &mut Vec<T>, len: usize) -> &mut [MaybeUninit<T>] {
    assert!(v.capacity() >= len);
    let v_ptr = v.as_mut_ptr().cast::<MaybeUninit<T>>();
    unsafe {
        // SAFETY: `v_ptr` is a valid pointer to a buffer of length at least `len`. Upon return, the
        // lifetime will be bound to that of `v`. The underlying memory will not be deallocated as
        // we hold the sole mutable reference to `v`. The contents of the slice may be
        // uninitialized, but the `MaybeUninit` makes it safe.
        slice::from_raw_parts_mut(v_ptr, len)
    }
}

pub fn fill_subtree<F: RichField, H: Hasher<F>>(
    digests_buf: &mut [MaybeUninit<H::Hash>],
    leaves: &[Vec<F>],
) -> H::Hash {
    assert_eq!(leaves.len(), digests_buf.len() / 2 + 1);
    if digests_buf.is_empty() {
        H::hash_leaf(&leaves[0])
    } else {
        // Layout is: left recursive output || left child digest
        //             || right child digest || right recursive output.
        // Split `digests_buf` into the two recursive outputs (slices) and two child digests
        // (references).
        let (left_digests_buf, right_digests_buf) = digests_buf.split_at_mut(digests_buf.len() / 2);
        let (left_digest_mem, left_digests_buf) = left_digests_buf.split_last_mut().unwrap();
        let (right_digest_mem, right_digests_buf) = right_digests_buf.split_first_mut().unwrap();
        // Split `leaves` between both children.
        let (left_leaves, right_leaves) = leaves.split_at(leaves.len() / 2);

        let left_digest = fill_subtree::<F, H>(left_digests_buf, left_leaves);
        let right_digest = fill_subtree::<F, H>(right_digests_buf, right_leaves);

        left_digest_mem.write(left_digest);
        right_digest_mem.write(right_digest);
        H::two_to_one(left_digest, right_digest)
    }
}

pub fn fill_digests_buf<F: RichField, H: Hasher<F>>(
    digests_buf: &mut [MaybeUninit<H::Hash>],
    cap_buf: &mut [MaybeUninit<H::Hash>],
    leaves: &[Vec<F>],
    cap_height: usize,
) {
    // Special case of a tree that's all cap. The usual case will panic because we'll try to split
    // an empty slice into chunks of `0`. (We would not need this if there was a way to split into
    // `blah` chunks as opposed to chunks _of_ `blah`.)
    if digests_buf.is_empty() {
        debug_assert_eq!(cap_buf.len(), leaves.len());
        cap_buf.iter_mut().zip(leaves).for_each(|(cap_buf, leaf)| {
            cap_buf.write(H::hash_leaf(leaf));
        });
        return;
    }

    let subtree_digests_len = digests_buf.len() >> cap_height;
    let subtree_leaves_len = leaves.len() >> cap_height;
    let digests_chunks = digests_buf.chunks_exact_mut(subtree_digests_len);
    let leaves_chunks = leaves.chunks_exact(subtree_leaves_len);
    assert_eq!(digests_chunks.len(), cap_buf.len());
    assert_eq!(digests_chunks.len(), leaves_chunks.len());
    digests_chunks.zip(cap_buf).zip(leaves_chunks).for_each(
        |((subtree_digests, subtree_cap), subtree_leaves)| {
            // We have `1 << cap_height` sub-trees, one for each entry in `cap`. They are totally
            // independent, so we schedule one task for each. `digests_buf` and `leaves` are split
            // into `1 << cap_height` slices, one for each sub-tree.
            subtree_cap.write(fill_subtree::<F, H>(subtree_digests, subtree_leaves));
        },
    );
}

pub fn merkle_tree_prove<F: RichField, H: Hasher<F>>(
    leaf_index: usize,
    leaves_len: usize,
    cap_height: usize,
    digests: &[H::Hash],
) -> Vec<H::Hash> {
    let num_layers = log2_strict(leaves_len) - cap_height;
    debug_assert_eq!(leaf_index >> (cap_height + num_layers), 0);

    let digest_len = 2 * (leaves_len - (1 << cap_height));
    assert_eq!(digest_len, digests.len());

    let digest_tree: &[H::Hash] = {
        let tree_index = leaf_index >> num_layers;
        let tree_len = digest_len >> cap_height;
        &digests[tree_len * tree_index..tree_len * (tree_index + 1)]
    };

    // Mask out high bits to get the index within the sub-tree.
    let mut pair_index = leaf_index & ((1 << num_layers) - 1);
    (0..num_layers)
        .map(|i| {
            let parity = pair_index & 1;
            pair_index >>= 1;

            // The layers' data is interleaved as follows:
            // [layer 0, layer 1, layer 0, layer 2, layer 0, layer 1, layer 0, layer 3, ...].
            // Each of the above is a pair of siblings.
            // `pair_index` is the index of the pair within layer `i`.
            // The index of that the pair within `digests` is
            // `pair_index * 2 ** (i + 1) + (2 ** i - 1)`.
            let siblings_index = (pair_index << (i + 1)) + (1 << i) - 1;
            // We have an index for the _pair_, but we want the index of the _sibling_.
            // Double the pair index to get the index of the left sibling. Conditionally add `1`
            // if we are to retrieve the right sibling.
            let sibling_index = 2 * siblings_index + (1 - parity);
            digest_tree[sibling_index]
        })
        .collect()
}

impl<F: RichField, H: Hasher<F>> MerkleTree<F, H> {
    pub fn new(leaves: Vec<Vec<F>>, cap_height: usize) -> Self {
        let log2_leaves_len = log2_strict(leaves.len());
        assert!(
            cap_height <= log2_leaves_len,
            "cap_height={} should be at most log2(leaves.len())={}",
            cap_height,
            log2_leaves_len
        );

        let num_digests = 2 * (leaves.len() - (1 << cap_height));
        let mut digests = Vec::with_capacity(num_digests);

        let len_cap = 1 << cap_height;
        let mut cap = Vec::with_capacity(len_cap);

        let digests_buf = capacity_up_to_mut(&mut digests, num_digests);
        let cap_buf = capacity_up_to_mut(&mut cap, len_cap);
        fill_digests_buf::<F, H>(digests_buf, cap_buf, &leaves[..], cap_height);

        unsafe {
            // SAFETY: `fill_digests_buf` and `cap` initialized the spare capacity up to
            // `num_digests` and `len_cap`, resp.
            digests.set_len(num_digests);
            cap.set_len(len_cap);
        }

        Self {
            leaves,
            digests,
            cap: MerkleCap(cap),
        }
    }

    pub fn get(&self, i: usize) -> &[F] {
        &self.leaves[i]
    }

    /// Create a Merkle proof from a leaf index.
    pub fn prove(&self, leaf_index: usize) -> MerkleProof<F, H> {
        let cap_height = log2_strict(self.cap.len());
        let siblings =
            merkle_tree_prove::<F, H>(leaf_index, self.leaves.len(), cap_height, &self.digests);

        MerkleProof { siblings }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    #[cfg(not(feature = "std"))]
    use alloc::vec;

    use anyhow::Result;
    use rand::rngs::SmallRng;
    use rand::SeedableRng;

    use super::*;
    use crate::config::{GenericConfig, PoseidonGoldilocksConfig};
    use crate::field::extension::Extendable;
    use crate::field::types::{Field, Sample};
    use crate::merkle_proofs::verify_merkle_proof_to_cap;

    pub(crate) fn random_data<F: Field + Sample>(n: usize, k: usize) -> Vec<Vec<F>> {
        let mut rng = SmallRng::seed_from_u64(42);
        (0..n)
            .map(|_| (0..k).map(|_| F::sample(&mut rng)).collect())
            .collect()
    }

    fn verify_all_leaves<
        F: RichField + Extendable<D>,
        C: GenericConfig<D, F = F>,
        const D: usize,
    >(
        leaves: Vec<Vec<F>>,
        cap_height: usize,
    ) -> Result<()> {
        let tree = MerkleTree::<F, C::Hasher>::new(leaves.clone(), cap_height);
        for (i, leaf) in leaves.into_iter().enumerate() {
            let proof = tree.prove(i);
            verify_merkle_proof_to_cap(leaf, i, &tree.cap, &proof)?;
        }
        Ok(())
    }

    #[test]
    #[should_panic]
    fn test_cap_height_too_big() {
        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;

        let log_n = 8;
        let cap_height = log_n + 1; // Should panic if `cap_height > len_n`.

        let leaves = random_data::<F>(1 << log_n, 7);
        let _ = MerkleTree::<F, <C as GenericConfig<D>>::Hasher>::new(leaves, cap_height);
    }

    #[test]
    fn test_cap_height_eq_log2_len() -> Result<()> {
        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;

        let log_n = 8;
        let n = 1 << log_n;
        let leaves = random_data::<F>(n, 7);

        verify_all_leaves::<F, C, D>(leaves, log_n)?;

        Ok(())
    }

    #[test]
    fn test_merkle_trees() -> Result<()> {
        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;

        let log_n = 8;
        let n = 1 << log_n;
        let leaves = random_data::<F>(n, 7);

        verify_all_leaves::<F, C, D>(leaves, 1)?;

        Ok(())
    }

    /// Regression test: Verify that domain-separated `hash_leaf` prevents
    /// internal nodes from being presented as fake leaves.
    ///
    /// Background: Without domain separation, `hash_no_pad([L||R])` equals
    /// `two_to_one(L, R)` when the input has exactly RATE elements. This would
    /// allow an attacker to forge Merkle proofs by presenting an internal node's
    /// children as a fake leaf.
    ///
    /// The fix: `hash_leaf` uses a domain separator in the capacity region
    /// (state[RATE] = 1 before first permutation). Since `two_to_one`/`compress`
    /// always uses all-zero capacity, no grind on rate-region values can produce
    /// a collision. This ensures `hash_leaf(data) != two_to_one(...)` for any input.
    #[test]
    fn test_internal_node_cannot_masquerade_as_leaf() {
        use crate::config::Hasher;
        use crate::hash_types::NUM_HASH_OUT_ELTS;
        use crate::merkle_proofs::{verify_merkle_proof_to_cap, MerkleProof};

        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;
        type H = <C as GenericConfig<D>>::Hasher;

        // Create a tree with 4 leaves, each with 7 elements (not RATE-sized)
        let leaves = random_data::<F>(4, 7);
        let tree = MerkleTree::<F, H>::new(leaves.clone(), 0); // cap_height=0 means root is the cap

        // Get a valid proof for leaf 0
        let valid_proof = tree.prove(0);

        // The valid proof should work
        assert!(
            verify_merkle_proof_to_cap(leaves[0].clone(), 0, &tree.cap, &valid_proof).is_ok(),
            "Valid proof should verify"
        );

        // Demonstrate that the underlying hash collision still exists at the primitive level
        // (this is expected - hash_no_pad has no domain separation):
        // 1. Get the leaf hashes using hash_no_pad (NOT hash_leaf)
        let leaf0_hash_no_pad = H::hash_no_pad(&leaves[0]);
        let leaf1_hash_no_pad = H::hash_no_pad(&leaves[1]);

        // 2. Compute what the internal node would be if leaves were hashed with hash_no_pad
        let internal_if_no_pad = H::two_to_one(leaf0_hash_no_pad, leaf1_hash_no_pad);

        // 3. Construct a fake leaf that is [hash || hash] - exactly 8 elements (RATE for Poseidon)
        let mut fake_leaf = Vec::with_capacity(NUM_HASH_OUT_ELTS * 2);
        fake_leaf.extend_from_slice(&leaf0_hash_no_pad.to_vec());
        fake_leaf.extend_from_slice(&leaf1_hash_no_pad.to_vec());

        // 4. hash_no_pad of this fake leaf equals the internal node (the primitive-level collision)
        let fake_leaf_hash_no_pad = H::hash_no_pad(&fake_leaf);
        assert_eq!(
            fake_leaf_hash_no_pad, internal_if_no_pad,
            "Primitive collision exists: hash_no_pad([L||R]) == two_to_one(L, R)"
        );

        // 5. But hash_leaf uses domain separation, so it produces a DIFFERENT hash
        let fake_leaf_hash_leaf = H::hash_leaf(&fake_leaf);
        assert_ne!(
            fake_leaf_hash_leaf, internal_if_no_pad,
            "Domain separation should make hash_leaf([L||R]) != two_to_one(L, R)"
        );

        // 6. Attempt to forge a proof (this should fail due to domain separation)
        //
        //    Original tree structure (cap_height=0):
        //           root
        //          /    \
        //      internal  internal
        //       /  \       /  \
        //      L0  L1    L2   L3
        //
        //    Forged proof: claim fake_leaf [H(L0)||H(L1)] is at index 0 with siblings = [H(internal_right)]

        // Get the sibling of the left internal node
        let leaf2_hash = H::hash_leaf(&leaves[2]);
        let leaf3_hash = H::hash_leaf(&leaves[3]);
        let right_internal = H::two_to_one(leaf2_hash, leaf3_hash);

        // Forged proof with one fewer level
        let forged_proof = MerkleProof {
            siblings: vec![right_internal],
        };

        // This verification MUST FAIL because hash_leaf has domain separation
        let forged_result = verify_merkle_proof_to_cap(fake_leaf, 0, &tree.cap, &forged_proof);

        assert!(
            forged_result.is_err(),
            "REGRESSION: Forged proof was accepted! Domain separation is broken."
        );
    }

    /// Verify that hash_leaf provides domain separation from two_to_one.
    /// Even when given input [L||R] that matches what two_to_one would hash,
    /// hash_leaf must produce a different result.
    #[test]
    fn test_hash_leaf_domain_separation() {
        use crate::config::Hasher;
        use crate::hash_types::NUM_HASH_OUT_ELTS;

        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;
        type H = <C as GenericConfig<D>>::Hasher;

        // Create two arbitrary hashes (simulating child node hashes)
        let left = H::hash_no_pad(&[F::from_canonical_u64(1), F::from_canonical_u64(2)]);
        let right = H::hash_no_pad(&[F::from_canonical_u64(3), F::from_canonical_u64(4)]);

        // Compute two_to_one (internal node hash)
        let internal_hash = H::two_to_one(left, right);

        // Construct the concatenated input [left || right]
        let mut concatenated = Vec::with_capacity(NUM_HASH_OUT_ELTS * 2);
        concatenated.extend_from_slice(&left.to_vec());
        concatenated.extend_from_slice(&right.to_vec());

        // hash_leaf of this concatenated input MUST differ from two_to_one
        let leaf_hash = H::hash_leaf(&concatenated);

        assert_ne!(
            leaf_hash, internal_hash,
            "Domain separation failed: hash_leaf([L||R]) == two_to_one(L, R)"
        );

        // Also verify that hash_no_pad DOES produce the same result (the vulnerability we're preventing)
        let no_pad_hash = H::hash_no_pad(&concatenated);
        assert_eq!(
            no_pad_hash, internal_hash,
            "Expected collision: hash_no_pad([L||R]) should equal two_to_one(L, R) for RATE-sized input"
        );
    }

    /// Regression test for #64703: leaf hashing must be length-binding so a zero-suffixed leaf
    /// cannot reuse another leaf's Merkle proof.
    #[test]
    fn test_zero_suffix_leaf_collision_rejected() {
        use crate::config::Hasher;

        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;
        type H = <C as GenericConfig<D>>::Hasher;

        let leaf = (1..=5).map(F::from_canonical_u64).collect::<Vec<_>>();
        let mut zero_suffixed = leaf.clone();
        zero_suffixed.push(F::ZERO);

        // The padded leaf hash is injective in length.
        assert_ne!(H::hash_leaf(&leaf), H::hash_leaf(&zero_suffixed));

        let leaves = vec![leaf.clone(), vec![F::from_canonical_u64(9); 5]];
        let tree = MerkleTree::<F, H>::new(leaves, 0);
        let proof = tree.prove(0);

        verify_merkle_proof_to_cap(leaf, 0, &tree.cap, &proof).unwrap();
        assert!(verify_merkle_proof_to_cap(zero_suffixed, 0, &tree.cap, &proof).is_err());
    }
}
