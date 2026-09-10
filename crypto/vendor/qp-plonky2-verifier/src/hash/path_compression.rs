//! Merkle proof path compression utilities.
//!
//! Re-exports path compression functions from core.

pub use qp_plonky2_core::hash::path_compression::{
    compress_merkle_proofs, decompress_merkle_proofs,
};

#[cfg(test)]
mod tests {
    #[cfg(not(feature = "std"))]
    use alloc::{vec, vec::Vec};

    use qp_plonky2_core::merkle_tree::MerkleTree;
    use rand::rngs::SmallRng;
    use rand::{RngExt, SeedableRng};

    use super::*;
    use crate::field::types::Sample;
    use crate::plonk::config::{GenericConfig, PoseidonGoldilocksConfig};

    #[test]
    fn test_path_compression() {
        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;
        let h = 10;
        let cap_height = 3;
        let mut rng = SmallRng::seed_from_u64(42);
        let vs: Vec<Vec<F>> = (0..1 << h).map(|_| vec![F::sample(&mut rng)]).collect();
        let mt = MerkleTree::<F, <C as GenericConfig<D>>::Hasher>::new(vs.clone(), cap_height);

        let k = rng.random_range(1..=1 << h);
        let indices: Vec<usize> = (0..k).map(|_| rng.random_range(0..1 << h)).collect();
        let proofs: Vec<_> = indices.iter().map(|&i| mt.prove(i)).collect();

        let compressed_proofs = compress_merkle_proofs(cap_height, &indices, &proofs);
        let decompressed_proofs = decompress_merkle_proofs(
            &indices.iter().map(|&i| vs[i].clone()).collect::<Vec<_>>(),
            &indices,
            &compressed_proofs,
            h,
            cap_height,
        );

        assert_eq!(proofs, decompressed_proofs);

        #[cfg(feature = "std")]
        {
            let mut compressed_proof_bytes = Vec::new();
            ciborium::into_writer(&compressed_proofs, &mut compressed_proof_bytes).unwrap();
            println!(
                "Compressed proof length: {} bytes",
                compressed_proof_bytes.len()
            );
            let mut proof_bytes = Vec::new();
            ciborium::into_writer(&proofs, &mut proof_bytes).unwrap();
            println!("Proof length: {} bytes", proof_bytes.len());
        }
    }
}
