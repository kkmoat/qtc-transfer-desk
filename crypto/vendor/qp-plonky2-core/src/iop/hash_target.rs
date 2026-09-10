//! Hash target types representing hash outputs in circuit form.

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

use anyhow::ensure;

use crate::hash_types::NUM_HASH_OUT_ELTS;
use crate::iop::target::Target;

/// Represents a ~256 bit hash output in circuit form.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct HashOutTarget {
    pub elements: [Target; NUM_HASH_OUT_ELTS],
}

impl HashOutTarget {
    // TODO: Switch to a TryFrom impl.
    pub fn from_vec(elements: Vec<Target>) -> Self {
        debug_assert!(elements.len() == NUM_HASH_OUT_ELTS);
        Self {
            elements: elements.try_into().unwrap(),
        }
    }

    pub fn from_partial(elements_in: &[Target], zero: Target) -> Self {
        let mut elements = [zero; NUM_HASH_OUT_ELTS];
        elements[0..elements_in.len()].copy_from_slice(elements_in);
        Self { elements }
    }
}

impl From<[Target; NUM_HASH_OUT_ELTS]> for HashOutTarget {
    fn from(elements: [Target; NUM_HASH_OUT_ELTS]) -> Self {
        Self { elements }
    }
}

impl TryFrom<&[Target]> for HashOutTarget {
    type Error = anyhow::Error;

    fn try_from(elements: &[Target]) -> Result<Self, Self::Error> {
        ensure!(elements.len() == NUM_HASH_OUT_ELTS);
        Ok(Self {
            elements: elements.try_into().unwrap(),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MerkleCapTarget(pub Vec<HashOutTarget>);
