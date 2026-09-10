//! Logic common to multiple IOPs.

// Re-export IOP types from core
// Re-export Challenger from core
pub use qp_plonky2_core::iop::{ext_target, target, wire};
pub use qp_plonky2_core::{
    challenger, flatten_target, unflatten_target, BoolTarget, ExtensionAlgebraTarget,
    ExtensionTarget, Target, Wire,
};
