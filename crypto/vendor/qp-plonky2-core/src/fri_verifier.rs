//! FRI verification logic shared between prover and verifier.

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

use anyhow::{ensure, Result};

use crate::config::{GenericConfig, Hasher};
use crate::field::extension::{flatten, Extendable, FieldExtension};
use crate::field::interpolation::{barycentric_weights, interpolate};
use crate::field::types::Field;
use crate::fri::FriParams;
use crate::fri_proof::{FriInitialTreeProof, FriProof, FriQueryRound};
use crate::fri_structure::{
    FriBatchInfo, FriChallenges, FriCoefficient, FriInstanceInfo, FriOpeningExpression, FriOpenings,
};
use crate::fri_validate_shape::validate_fri_proof_shape;
use crate::hash_types::RichField;
use crate::merkle_proofs::verify_merkle_proof_to_cap;
use crate::merkle_tree::MerkleCap;
use crate::reducing::ReducingFactor;
use crate::util::{cached_point_power, log2_strict, reverse_bits, reverse_index_bits_in_place};

/// Computes P'(x^arity) from {P(x*g^i)}_(i=0..arity), where g is a `arity`-th root of unity
/// and P' is the FRI reduced polynomial.
pub fn compute_evaluation<F: Field + Extendable<D>, const D: usize>(
    x: F,
    x_index_within_coset: usize,
    arity_bits: usize,
    evals: &[F::Extension],
    beta: F::Extension,
) -> F::Extension {
    let arity = 1 << arity_bits;
    debug_assert_eq!(evals.len(), arity);

    let g = F::primitive_root_of_unity(arity_bits);

    // Commit-phase leaves are stored in bit-reversed order, so first undo that permutation.
    // Then recover the actual start of this queried coset: the opened chunk may begin at
    // `x * g^j`, while interpolation expects the values ordered over `{coset_start, coset_start *
    // g, coset_start * g^2, ...}`.
    let mut evals = evals.to_vec();
    reverse_index_bits_in_place(&mut evals);
    let rev_x_index_within_coset = reverse_bits(x_index_within_coset, arity_bits);
    let coset_start = x * g.exp_u64((arity - rev_x_index_within_coset) as u64);
    // The answer is gotten by interpolating {(x*g^i, P(x*g^i))} and evaluating at beta.
    let points = g
        .powers()
        .map(|y| (coset_start * y).into())
        .zip(evals)
        .collect::<Vec<_>>();
    let barycentric_weights = barycentric_weights(&points);
    interpolate(&points, beta, &barycentric_weights)
}

pub fn fri_verify_proof_of_work<F: RichField + Extendable<D>, const D: usize>(
    fri_pow_response: F,
    config: &crate::fri::FriConfig,
) -> Result<()> {
    ensure!(
        fri_pow_response.to_canonical_u64().leading_zeros()
            >= config.proof_of_work_bits + (64 - F::order().bits()) as u32,
        "Invalid proof of work witness."
    );

    Ok(())
}

pub fn verify_fri_proof<
    F: RichField + Extendable<D>,
    C: GenericConfig<D, F = F>,
    const D: usize,
>(
    instance: &FriInstanceInfo<F, D>,
    openings: &FriOpenings<F, D>,
    challenges: &FriChallenges<F, D>,
    initial_merkle_caps: &[MerkleCap<F, C::Hasher>],
    proof: &FriProof<F, C::Hasher, D>,
    params: &FriParams,
) -> Result<()> {
    validate_fri_proof_shape::<F, C, D>(proof, instance, params)?;

    // Size of the LDE domain.
    let n = params.lde_size();

    // Check PoW.
    fri_verify_proof_of_work(challenges.fri_pow_response, &params.config)?;

    // Check that parameters are coherent.
    ensure!(
        params.config.num_query_rounds == proof.query_round_proofs.len(),
        "Number of query rounds does not match config."
    );

    let precomputed_reduced_evals =
        PrecomputedReducedOpenings::from_os_and_alpha(openings, challenges.fri_alpha);
    for (query_round_index, (&x_index, round_proof)) in challenges
        .fri_query_indices
        .iter()
        .zip(&proof.query_round_proofs)
        .enumerate()
    {
        fri_verifier_query_round::<F, C, D>(
            instance,
            challenges,
            &precomputed_reduced_evals,
            initial_merkle_caps,
            proof,
            query_round_index,
            x_index,
            n,
            round_proof,
            params,
        )?;
    }

    Ok(())
}

fn fri_verify_initial_proof<F: RichField, H: Hasher<F>>(
    x_index: usize,
    proof: &FriInitialTreeProof<F, H>,
    initial_merkle_caps: &[MerkleCap<F, H>],
) -> Result<()> {
    for ((evals, merkle_proof), cap) in proof.evals_proofs.iter().zip(initial_merkle_caps) {
        verify_merkle_proof_to_cap::<F, H>(evals.clone(), x_index, cap, merkle_proof)?;
    }

    Ok(())
}

pub fn fri_combine_initial<
    F: RichField + Extendable<D>,
    C: GenericConfig<D, F = F>,
    const D: usize,
>(
    instance: &FriInstanceInfo<F, D>,
    proof: &FriInitialTreeProof<F, C::Hasher>,
    alpha: F::Extension,
    subgroup_x: F,
    precomputed_reduced_evals: &PrecomputedReducedOpenings<F, D>,
    params: &FriParams,
) -> F::Extension {
    assert!(D > 1, "Not implemented for D=1.");
    let subgroup_x = F::Extension::from_basefield(subgroup_x);
    let mut alpha = ReducingFactor::new(alpha);
    let mut sum = F::Extension::ZERO;

    for (batch, reduced_openings) in instance
        .batches
        .iter()
        .zip(&precomputed_reduced_evals.reduced_openings_at_point)
    {
        let FriBatchInfo { point, openings } = batch;
        let mut point_power_cache = Vec::new();
        let evals = openings.iter().map(|expression| {
            eval_opening_expression_with_point_powers(
                instance,
                expression,
                proof,
                *point,
                params,
                &mut point_power_cache,
            )
        });
        let reduced_evals = alpha.reduce(evals);
        let numerator = reduced_evals - *reduced_openings;
        let denominator = subgroup_x - *point;
        sum = alpha.shift(sum);
        sum += numerator / denominator;
    }

    sum
}

pub fn eval_opening_expression<F, H, const D: usize>(
    instance: &FriInstanceInfo<F, D>,
    expression: &FriOpeningExpression<F, D>,
    proof: &FriInitialTreeProof<F, H>,
    point: F::Extension,
    params: &FriParams,
) -> F::Extension
where
    F: RichField + Extendable<D>,
    H: Hasher<F>,
{
    let mut point_power_cache = Vec::new();
    eval_opening_expression_with_point_powers(
        instance,
        expression,
        proof,
        point,
        params,
        &mut point_power_cache,
    )
}

fn eval_opening_expression_with_point_powers<F, H, const D: usize>(
    instance: &FriInstanceInfo<F, D>,
    expression: &FriOpeningExpression<F, D>,
    proof: &FriInitialTreeProof<F, H>,
    point: F::Extension,
    params: &FriParams,
    point_power_cache: &mut Vec<(usize, F::Extension)>,
) -> F::Extension
where
    F: RichField + Extendable<D>,
    H: Hasher<F>,
{
    expression
        .terms
        .iter()
        .map(|term| {
            let coefficient = match &term.coefficient {
                FriCoefficient::One => F::Extension::ONE,
                FriCoefficient::PointPower(power) => {
                    cached_point_power(point, *power, point_power_cache)
                }
                FriCoefficient::Constant(constant) => *constant,
            };
            let poly_blinding = instance.oracles[term.polynomial.oracle_index].blinding;
            let salted = params.leaf_hiding && poly_blinding;
            let raw_eval = proof.unsalted_eval(
                term.polynomial.oracle_index,
                term.polynomial.polynomial_index,
                salted,
            );
            coefficient * F::Extension::from_basefield(raw_eval)
        })
        .sum()
}

fn fri_verifier_query_round<
    F: RichField + Extendable<D>,
    C: GenericConfig<D, F = F>,
    const D: usize,
>(
    instance: &FriInstanceInfo<F, D>,
    challenges: &FriChallenges<F, D>,
    precomputed_reduced_evals: &PrecomputedReducedOpenings<F, D>,
    initial_merkle_caps: &[MerkleCap<F, C::Hasher>],
    proof: &FriProof<F, C::Hasher, D>,
    _query_round_index: usize,
    mut x_index: usize,
    n: usize,
    round_proof: &FriQueryRound<F, C::Hasher, D>,
    params: &FriParams,
) -> Result<()> {
    fri_verify_initial_proof::<F, C::Hasher>(
        x_index,
        &round_proof.initial_trees_proof,
        initial_merkle_caps,
    )?;
    // `subgroup_x` is `subgroup[x_index]`, i.e., the actual field element in the domain.
    let log_n = log2_strict(n);
    let mut subgroup_x = F::MULTIPLICATIVE_GROUP_GENERATOR
        * F::primitive_root_of_unity(log_n).exp_u64(reverse_bits(x_index, log_n) as u64);

    // old_eval is the last derived evaluation; it will be checked for consistency with its
    // committed "parent" value in the next iteration.
    let mut old_eval = fri_combine_initial::<F, C, D>(
        instance,
        &round_proof.initial_trees_proof,
        challenges.fri_alpha,
        subgroup_x,
        precomputed_reduced_evals,
        params,
    );

    for (i, &arity_bits) in params.reduction_arity_bits.iter().enumerate() {
        let arity = 1 << arity_bits;
        let evals = &round_proof.steps[i].evals;

        // Split x_index into the index of the coset x is in, and the index of x within that coset.
        let coset_index = x_index >> arity_bits;
        let x_index_within_coset = x_index & (arity - 1);

        // Check consistency with our old evaluation from the previous round.
        ensure!(evals[x_index_within_coset] == old_eval);

        // Infer P(y) from {P(x)}_{x^arity=y}.
        old_eval = compute_evaluation(
            subgroup_x,
            x_index_within_coset,
            arity_bits,
            evals,
            challenges.fri_betas[i],
        );

        verify_merkle_proof_to_cap::<F, C::Hasher>(
            flatten(evals),
            coset_index,
            &proof.commit_phase_merkle_caps[i],
            &round_proof.steps[i].merkle_proof,
        )?;

        // Update the point x to x^arity.
        subgroup_x = subgroup_x.exp_power_of_2(arity_bits);

        x_index = coset_index;
    }

    // Final check of FRI. After all the reductions, we check that the final polynomial is equal
    // to the one sent by the prover.
    ensure!(
        proof.final_poly.eval(subgroup_x.into()) == old_eval,
        "Final polynomial evaluation is invalid."
    );

    Ok(())
}

/// For each opening point, holds the reduced (by `alpha`) evaluations of each polynomial that's
/// opened at that point.
#[derive(Clone, Debug)]
pub struct PrecomputedReducedOpenings<F: RichField + Extendable<D>, const D: usize> {
    pub reduced_openings_at_point: Vec<F::Extension>,
}

impl<F: RichField + Extendable<D>, const D: usize> PrecomputedReducedOpenings<F, D> {
    pub fn from_os_and_alpha(openings: &FriOpenings<F, D>, alpha: F::Extension) -> Self {
        let reduced_openings_at_point = openings
            .batches
            .iter()
            .map(|batch| ReducingFactor::new(alpha).reduce(batch.values.iter()))
            .collect();
        Self {
            reduced_openings_at_point,
        }
    }
}
