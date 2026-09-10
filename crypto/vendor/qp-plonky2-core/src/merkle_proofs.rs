#[cfg(not(feature = "std"))]
use alloc::{vec, vec::Vec};

use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

use crate::config::{GenericHashOut, Hasher};
use crate::hash_types::RichField;
use crate::merkle_tree::MerkleCap;

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(bound = "")]
pub struct MerkleProof<F: RichField, H: Hasher<F>> {
    /// The Merkle digest of each sibling subtree, staying from the bottommost layer.
    pub siblings: Vec<H::Hash>,
}

impl<F: RichField, H: Hasher<F>> MerkleProof<F, H> {
    pub fn len(&self) -> usize {
        self.siblings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Verifies that the given leaf data is present at the given index in the Merkle tree with the
/// given root.
pub fn verify_merkle_proof<F: RichField, H: Hasher<F>>(
    leaf_data: Vec<F>,
    leaf_index: usize,
    merkle_root: H::Hash,
    proof: &MerkleProof<F, H>,
) -> Result<()> {
    let merkle_cap = MerkleCap(vec![merkle_root]);
    verify_merkle_proof_to_cap(leaf_data, leaf_index, &merkle_cap, proof)
}

/// Verifies that the given leaf data is present at the given index in the Merkle tree with the
/// given cap.
pub fn verify_merkle_proof_to_cap<F: RichField, H: Hasher<F>>(
    leaf_data: Vec<F>,
    leaf_index: usize,
    merkle_cap: &MerkleCap<F, H>,
    proof: &MerkleProof<F, H>,
) -> Result<()> {
    verify_batch_merkle_proof_to_cap(
        &[leaf_data.clone()],
        &[proof.siblings.len()],
        leaf_index,
        merkle_cap,
        proof,
    )
}

/// Verifies that the given leaf data is present at the given index in the Field Merkle tree with the
/// given cap.
pub fn verify_batch_merkle_proof_to_cap<F: RichField, H: Hasher<F>>(
    leaf_data: &[Vec<F>],
    leaf_heights: &[usize],
    mut leaf_index: usize,
    merkle_cap: &MerkleCap<F, H>,
    proof: &MerkleProof<F, H>,
) -> Result<()> {
    assert_eq!(leaf_data.len(), leaf_heights.len());
    let mut current_digest = H::hash_leaf(&leaf_data[0]);
    let mut current_height = leaf_heights[0];
    let mut leaf_data_index = 1;
    for &sibling_digest in &proof.siblings {
        let bit = leaf_index & 1;
        leaf_index >>= 1;
        current_digest = if bit == 1 {
            H::two_to_one(sibling_digest, current_digest)
        } else {
            H::two_to_one(current_digest, sibling_digest)
        };
        current_height -= 1;

        if leaf_data_index < leaf_heights.len() && current_height == leaf_heights[leaf_data_index] {
            let mut new_leaves = current_digest.to_vec();
            new_leaves.extend_from_slice(&leaf_data[leaf_data_index]);
            // This is hashing a digest concatenated with additional leaf data.
            // Use hash_leaf for domain separation since this combined data
            // is semantically a leaf in the higher-level tree structure.
            current_digest = H::hash_leaf(&new_leaves);
            leaf_data_index += 1;
        }
    }
    assert_eq!(leaf_data_index, leaf_data.len());
    ensure!(
        current_digest == merkle_cap.0[leaf_index],
        "Invalid Merkle proof."
    );

    Ok(())
}
