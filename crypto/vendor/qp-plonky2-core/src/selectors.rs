//! Selector information shared between prover and verifier.

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;
use core::ops::Range;

use serde::Serialize;

/// Placeholder value to indicate that a gate doesn't use a selector polynomial.
pub const UNUSED_SELECTOR: usize = u32::MAX as usize;

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct SelectorsInfo {
    pub selector_indices: Vec<usize>,
    pub groups: Vec<Range<usize>>,
}

impl SelectorsInfo {
    pub fn num_selectors(&self) -> usize {
        self.groups.len()
    }
}

/// Enum listing the different selectors for lookup constraints:
/// - `TransSre` is for Sum and RE transition constraints.
/// - `TransLdc` is for LDC transition constraints.
/// - `InitSre` is for the initial constraint of Sum and Re.
/// - `LastLdc` is for the final LDC (and Sum) constraint.
/// - `StartEnd` indicates where lookup end selectors begin.
pub enum LookupSelectors {
    TransSre = 0,
    TransLdc,
    InitSre,
    LastLdc,
    StartEnd,
}
