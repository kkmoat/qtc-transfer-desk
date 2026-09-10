//! PLONK types shared between prover and verifier.

pub mod vars;

pub use vars::{
    EvaluationTargets, EvaluationVars, EvaluationVarsBase, EvaluationVarsBaseBatch,
    EvaluationVarsBaseBatchIter, EvaluationVarsBaseBatchIterPacked, EvaluationVarsBasePacked,
};
