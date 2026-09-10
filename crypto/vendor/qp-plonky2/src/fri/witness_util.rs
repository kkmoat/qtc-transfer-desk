use anyhow::{anyhow, Result};
use itertools::Itertools;
use plonky2_field::types::Field;

use crate::field::extension::Extendable;
use crate::fri::proof::{FriProof, FriProofTarget};
use crate::hash::hash_types::{HashOut, RichField};
use crate::iop::witness::WitnessWrite;
use crate::plonk::config::AlgebraicHasher;

/// Set the targets in a `FriProofTarget` to their corresponding values in a `FriProof`.
pub fn set_fri_proof_target<F, W, H, const D: usize>(
    witness: &mut W,
    fri_proof_target: &FriProofTarget<D>,
    fri_proof: &FriProof<F, H, D>,
) -> Result<()>
where
    F: RichField + Extendable<D>,
    W: WitnessWrite<F> + ?Sized,
    H: AlgebraicHasher<F>,
{
    witness.set_target(fri_proof_target.pow_witness, fri_proof.pow_witness)?;

    // Set final polynomial coefficients
    let target_len = fri_proof_target.final_poly.0.len();
    let coeffs_len = fri_proof.final_poly.coeffs.len();
    if target_len < coeffs_len {
        return Err(anyhow!(
            "fri_proof->final_poly target length is less than the proof length"
        ));
    }
    for i in 0..coeffs_len {
        witness.set_extension_target(
            fri_proof_target.final_poly.0[i],
            fri_proof.final_poly.coeffs[i],
        )?;
    }
    for i in coeffs_len..target_len {
        witness.set_extension_target(fri_proof_target.final_poly.0[i], F::Extension::ZERO)?;
    }

    let target_caps = &fri_proof_target.commit_phase_merkle_caps;
    let proof_caps = &fri_proof.commit_phase_merkle_caps;

    if target_caps.len() < proof_caps.len() {
        return Err(anyhow!(
            "fri_proof->commit_phase_merkle_caps's target length is less than the proof length"
        ));
    }

    // Set matching elements in both proof and target caps
    for (target_cap, proof_cap) in target_caps.iter().zip(proof_caps) {
        witness.set_cap_target(target_cap, proof_cap)?;
    }

    // Set remaining elements in target caps to ZERO if target is longer
    for target_cap in target_caps.iter().skip(proof_caps.len()) {
        for hash in target_cap.0.iter() {
            witness.set_hash_target(*hash, HashOut::ZERO)?;
        }
    }

    for (query_round_index, (qt, q)) in fri_proof_target
        .query_round_proofs
        .iter()
        .zip_eq(&fri_proof.query_round_proofs)
        .enumerate()
    {
        for (oracle_index, (at, a)) in qt
            .initial_trees_proof
            .evals_proofs
            .iter()
            .zip_eq(&q.initial_trees_proof.evals_proofs)
            .enumerate()
        {
            let target_len = at.0.len();
            let evals_len = a.0.len();
            if target_len < evals_len {
                return Err(anyhow!(
                    "fri_proof->query_round_proofs[{query_round_index}]->initial_trees_proof->evals_proofs[{oracle_index}] target length {target_len} is less than the proof length {evals_len}"
                ));
            }
            for i in 0..evals_len {
                witness.set_target(at.0[i], a.0[i])?;
            }
            for i in evals_len..target_len {
                witness.set_target(at.0[i], F::ZERO)?;
            }
            let target_len = at.1.siblings.len();
            let siblings_len = a.1.siblings.len();

            if target_len < siblings_len {
                return Err(anyhow!("fri_proof->query_round_proofs->initial_trees_proof->evals_proofs->siblings' target length is less than the proof length"));
            }

            // Set overlapping elements
            for i in 0..siblings_len {
                witness.set_hash_target(at.1.siblings[i], a.1.siblings[i])?;
            }

            // Set remaining elements in target to ZERO if target is longer
            for i in siblings_len..target_len {
                witness.set_hash_target(at.1.siblings[i], HashOut::ZERO)?;
            }
        }

        for (st, s) in qt.steps.iter().zip(&q.steps) {
            let target_len = st.evals.len();
            let evals_len = s.evals.len();
            if target_len < evals_len {
                return Err(anyhow!(
                    "fri_proof->query_round_proofs->steps->evals target length is less than the proof length"
                ));
            }
            for i in 0..evals_len {
                witness.set_extension_target(st.evals[i], s.evals[i])?;
            }
            for i in evals_len..target_len {
                witness.set_extension_target(st.evals[i], F::Extension::ZERO)?;
            }

            let target_len = st.merkle_proof.siblings.len();
            let siblings_len = s.merkle_proof.siblings.len();

            if target_len < siblings_len {
                return Err(anyhow!("fri_proof->query_round_proofs->steps->merkle_proof->siblings' target length is less than the proof length"));
            }

            // Set overlapping elements
            for i in 0..siblings_len {
                witness.set_hash_target(st.merkle_proof.siblings[i], s.merkle_proof.siblings[i])?;
            }

            // Set remaining elements in target to ZERO if target is longer
            for i in siblings_len..target_len {
                witness.set_hash_target(st.merkle_proof.siblings[i], HashOut::ZERO)?;
            }
        }

        // Set remaining steps in qt to ZERO if qt.steps is longer
        for st in qt.steps.iter().skip(q.steps.len()) {
            for &eval in &st.evals {
                witness.set_extension_target(eval, F::Extension::ZERO)?;
            }

            for &sibling in &st.merkle_proof.siblings {
                witness.set_hash_target(sibling, HashOut::ZERO)?;
            }
        }
    }

    Ok(())
}
