//! IOP (Interactive Oracle Proof) types shared between prover and verifier.
//!
//! This module contains the basic target and wire types used to represent
//! circuit witness locations.

pub mod ext_target;
pub mod hash_target;
pub mod target;
pub mod wire;

pub use ext_target::{flatten_target, unflatten_target, ExtensionAlgebraTarget, ExtensionTarget};
pub use hash_target::{HashOutTarget, MerkleCapTarget};
pub use target::{BoolTarget, Target};
pub use wire::Wire;
