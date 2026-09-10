//! FRI verification logic.
//!
//! Re-exports FRI verification functions from core.

pub use qp_plonky2_core::fri_verifier::{
    compute_evaluation, eval_opening_expression, fri_combine_initial, fri_verify_proof_of_work,
    verify_fri_proof, PrecomputedReducedOpenings,
};
