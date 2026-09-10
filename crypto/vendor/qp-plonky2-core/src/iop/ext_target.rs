//! Extension field target types for recursive verification.

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;
use core::ops::Range;

use crate::iop::target::Target;

/// `Target`s representing an element of an extension field.
///
/// This is typically used in recursion settings, where the outer circuit must verify
/// a proof satisfying an inner circuit's statement, which is verified using arithmetic
/// in an extension of the base field.
#[derive(Copy, Clone, Eq, PartialEq, Hash, Debug)]
pub struct ExtensionTarget<const D: usize>(pub [Target; D]);

impl<const D: usize> Default for ExtensionTarget<D> {
    fn default() -> Self {
        Self([Target::default(); D])
    }
}

impl<const D: usize> ExtensionTarget<D> {
    pub const fn to_target_array(&self) -> [Target; D] {
        self.0
    }

    pub fn from_range(row: usize, range: Range<usize>) -> Self {
        debug_assert_eq!(range.end - range.start, D);
        Target::wires_from_range(row, range).try_into().unwrap()
    }
}

impl<const D: usize> TryFrom<Vec<Target>> for ExtensionTarget<D> {
    type Error = Vec<Target>;

    fn try_from(value: Vec<Target>) -> Result<Self, Self::Error> {
        Ok(Self(value.try_into()?))
    }
}

/// `Target`s representing an element of an extension of an extension field.
#[derive(Copy, Clone, Debug)]
pub struct ExtensionAlgebraTarget<const D: usize>(pub [ExtensionTarget<D>; D]);

impl<const D: usize> ExtensionAlgebraTarget<D> {
    pub const fn to_ext_target_array(&self) -> [ExtensionTarget<D>; D] {
        self.0
    }
}

/// Flatten the slice by sending every extension target to its D-sized canonical representation.
pub fn flatten_target<const D: usize>(l: &[ExtensionTarget<D>]) -> Vec<Target> {
    l.iter()
        .flat_map(|x| x.to_target_array().to_vec())
        .collect()
}

/// Batch every D-sized chunks into extension targets.
pub fn unflatten_target<const D: usize>(l: &[Target]) -> Vec<ExtensionTarget<D>> {
    debug_assert_eq!(l.len() % D, 0);
    l.chunks_exact(D)
        .map(|c| c.to_vec().try_into().unwrap())
        .collect()
}

// Add the to_ext_target method to Target
impl Target {
    /// Conversion to an `ExtensionTarget`.
    pub const fn to_ext_target<const D: usize>(self, zero: Self) -> ExtensionTarget<D> {
        let mut arr = [zero; D];
        arr[0] = self;
        ExtensionTarget(arr)
    }
}
