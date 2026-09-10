//! plonky2 verification system.
//!
//! This module provides the verification functionality for plonky2 proofs.

pub mod circuit_data;
pub mod config;
mod get_challenges;
pub mod plonk_common;
pub mod proof;
mod validate_shape;
pub(crate) mod vanishing_poly;
pub mod vars;
pub mod verifier;
