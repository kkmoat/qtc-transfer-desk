//! Information about the structure of a FRI instance, in terms of the oracles and polynomials
//! involved, and the points they are opened at.
//!
//! These types are re-exported from qp-plonky2-core.

// Re-export all FRI structure types from core
pub use qp_plonky2_core::{
    FriBatchInfo, FriCoefficient, FriInstanceInfo, FriOpeningBatch, FriOpeningExpression,
    FriOpeningTerm, FriOpenings, FriOracleInfo, FriPolynomialInfo,
};
