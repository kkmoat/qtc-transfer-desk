#[cfg(not(feature = "std"))]
use alloc::{vec, vec::Vec};
use core::cmp::min;
use core::iter;

use itertools::Itertools;
use plonky2_field::polynomial::PolynomialCoeffs;

use crate::field::extension::{Extendable, FieldExtension};
use crate::field::types::Field;
use crate::gates::lookup::LookupGate;
use crate::gates::lookup_table::LookupTableGate;
use crate::gates::selectors::LookupSelectors;
use crate::hash::hash_types::RichField;
use crate::plonk::circuit_data::CommonCircuitData;
use crate::plonk::plonk_common;
use crate::plonk::vars::EvaluationVars;

/// Number of random coins needed for lookups (alpha, betas, gamma, delta).
pub(crate) const NUM_COINS_LOOKUP: usize = 4;

/// Enum listing the challenges needed for lookups.
/// `ChallengeA` is used for the linear combination of input and output pairs in the Sum and LDC polynomials.
/// `ChallengeB` is used for the linear combination of input and output pairs in the polynomial RE.
/// `ChallengeAlpha` is used for the running sums: 1/(alpha - combo_i).
/// `ChallengeDelta` is a challenge on which to evaluate the interpolated LUT function.
#[derive(Debug)]
pub enum LookupChallenges {
    ChallengeA = 0,
    ChallengeB = 1,
    ChallengeAlpha = 2,
    ChallengeDelta = 3,
}

/// Checks the relationship between each pair of partial product accumulators. In particular, this
/// sequence of accumulators starts with `Z(x)`, then contains each partial product polynomials
/// `p_i(x)`, and finally `Z(g x)`. See the partial products section of the Plonky2 paper.
pub(crate) fn check_partial_products<F: Field>(
    numerators: &[F],
    denominators: &[F],
    partials: &[F],
    z_x: F,
    z_gx: F,
    max_degree: usize,
) -> Vec<F> {
    debug_assert!(max_degree > 1);
    let product_accs = iter::once(&z_x)
        .chain(partials.iter())
        .chain(iter::once(&z_gx));
    let chunk_size = max_degree;
    numerators
        .chunks(chunk_size)
        .zip_eq(denominators.chunks(chunk_size))
        .zip_eq(product_accs.tuple_windows())
        .map(|((nume_chunk, deno_chunk), (&prev_acc, &next_acc))| {
            let num_chunk_product = nume_chunk.iter().copied().product();
            let den_chunk_product = deno_chunk.iter().copied().product();
            // Assert that next_acc * deno_product = prev_acc * nume_product.
            prev_acc * num_chunk_product - next_acc * den_chunk_product
        })
        .collect()
}

/// Get the polynomial associated to a lookup table with current challenges.
pub(crate) fn get_lut_poly<F: RichField + Extendable<D>, const D: usize>(
    common_data: &CommonCircuitData<F, D>,
    lut_index: usize,
    deltas: &[F],
    degree: usize,
) -> PolynomialCoeffs<F> {
    let b = deltas[LookupChallenges::ChallengeB as usize];
    let mut coeffs = Vec::with_capacity(common_data.luts[lut_index].len());
    let n = common_data.luts[lut_index].len();
    let nb_slots = LookupTableGate::num_slots(&common_data.config);
    let nb_padded_elts = (nb_slots - n % nb_slots) % nb_slots;
    let (padding_inp, padding_out) = common_data.luts[lut_index][0];
    for (input, output) in common_data.luts[lut_index].iter() {
        coeffs.push(F::from_canonical_u16(*input) + b * F::from_canonical_u16(*output));
    }
    // Padding with the first element of the LUT.
    for _ in 0..nb_padded_elts {
        coeffs.push(F::from_canonical_u16(padding_inp) + b * F::from_canonical_u16(padding_out));
    }
    coeffs.append(&mut vec![F::ZERO; degree - (n + nb_padded_elts)]);
    coeffs.reverse();
    PolynomialCoeffs::new(coeffs)
}

/// Evaluate the vanishing polynomial at `x`. In this context, the vanishing polynomial is a random
/// linear combination of gate constraints, plus some other terms relating to the permutation
/// argument. All such terms should vanish on `H`.
pub(crate) fn eval_vanishing_poly<F: RichField + Extendable<D>, const D: usize>(
    common_data: &CommonCircuitData<F, D>,
    x: F::Extension,
    vars: EvaluationVars<F, D>,
    local_zs: &[F::Extension],
    next_zs: &[F::Extension],
    local_lookup_zs: &[F::Extension],
    next_lookup_zs: &[F::Extension],
    partial_products: &[F::Extension],
    s_sigmas: &[F::Extension],
    betas: &[F],
    gammas: &[F],
    alphas: &[F],
    deltas: &[F],
) -> Vec<F::Extension> {
    let has_lookup = common_data.num_lookup_polys != 0;
    let max_degree = common_data.permutation_partial_product_degree();
    let num_prods = common_data.num_partial_products;

    let constraint_terms = evaluate_gate_constraints::<F, D>(common_data, vars);

    let lookup_selectors = &vars.local_constants[common_data.selectors_info.num_selectors()
        ..common_data.selectors_info.num_selectors() + common_data.num_lookup_selectors];

    // The L_0(x) (Z(x) - 1) vanishing terms.
    let mut vanishing_z_1_terms = Vec::new();

    // The terms checking the lookup constraints, if any.
    let mut vanishing_all_lookup_terms = if has_lookup {
        let num_sldc_polys = common_data.num_lookup_polys - 1;
        Vec::with_capacity(
            common_data.config.num_challenges * (4 + common_data.luts.len() + 2 * num_sldc_polys),
        )
    } else {
        Vec::new()
    };

    // The terms checking the partial products.
    let mut vanishing_partial_products_terms = Vec::new();

    let l_0_x = plonk_common::eval_l_0(common_data.degree(), x);

    for i in 0..common_data.config.num_challenges {
        let z_x = local_zs[i];
        let z_gx = next_zs[i];
        vanishing_z_1_terms.push(l_0_x * (z_x - F::Extension::ONE));

        if has_lookup {
            let cur_local_lookup_zs = &local_lookup_zs
                [common_data.num_lookup_polys * i..common_data.num_lookup_polys * (i + 1)];
            let cur_next_lookup_zs = &next_lookup_zs
                [common_data.num_lookup_polys * i..common_data.num_lookup_polys * (i + 1)];

            let cur_deltas = &deltas[NUM_COINS_LOOKUP * i..NUM_COINS_LOOKUP * (i + 1)];

            let lookup_constraints = check_lookup_constraints(
                common_data,
                vars,
                cur_local_lookup_zs,
                cur_next_lookup_zs,
                lookup_selectors,
                cur_deltas.try_into().unwrap(),
            );

            vanishing_all_lookup_terms.extend(lookup_constraints);
        }

        let numerator_values = (0..common_data.config.num_routed_wires)
            .map(|j| {
                let wire_value = vars.local_wires[j];
                let k_i = common_data.k_is[j];
                let s_id = x.scalar_mul(k_i);
                wire_value + s_id.scalar_mul(betas[i]) + gammas[i].into()
            })
            .collect::<Vec<_>>();
        let denominator_values = (0..common_data.config.num_routed_wires)
            .map(|j| {
                let wire_value = vars.local_wires[j];
                let s_sigma = s_sigmas[j];
                wire_value + s_sigma.scalar_mul(betas[i]) + gammas[i].into()
            })
            .collect::<Vec<_>>();

        // The partial products considered for this iteration of `i`.
        let current_partial_products = &partial_products[i * num_prods..(i + 1) * num_prods];
        // Check the quotient partial products.
        let partial_product_checks = check_partial_products(
            &numerator_values,
            &denominator_values,
            current_partial_products,
            z_x,
            z_gx,
            max_degree,
        );
        vanishing_partial_products_terms.extend(partial_product_checks);
    }

    let vanishing_terms = [
        vanishing_z_1_terms,
        vanishing_partial_products_terms,
        vanishing_all_lookup_terms,
        constraint_terms,
    ]
    .concat();

    let alphas = &alphas.iter().map(|&a| a.into()).collect::<Vec<_>>();
    plonk_common::reduce_with_powers_multi(&vanishing_terms, alphas)
}

/// Evaluates all lookup constraints, based on the logarithmic derivatives paper (<https://eprint.iacr.org/2022/1530.pdf>),
/// following the Tip5 paper's implementation (<https://eprint.iacr.org/2023/107.pdf>).
///
/// There are three polynomials to check:
/// - RE ensures the well formation of lookup tables;
/// - Sum is a running sum of m_i/(X - (input_i + a * output_i)) where (input_i, output_i) are input pairs in the lookup table (LUT);
/// - LDC is a running sum of 1/(X - (input_i + a * output_i)) where (input_i, output_i) are input pairs that look in the LUT.
///
/// Sum and LDC are broken down in partial polynomials to lower the constraint degree, similarly to the permutation argument.
/// They also share the same partial SLDC polynomials, so that the last SLDC value is Sum(end) - LDC(end). The final constraint
/// Sum(end) = LDC(end) becomes simply SLDC(end) = 0, and we can remove the LDC initial constraint.
pub fn check_lookup_constraints<F: RichField + Extendable<D>, const D: usize>(
    common_data: &CommonCircuitData<F, D>,
    vars: EvaluationVars<F, D>,
    local_lookup_zs: &[F::Extension],
    next_lookup_zs: &[F::Extension],
    lookup_selectors: &[F::Extension],
    deltas: &[F; 4],
) -> Vec<F::Extension> {
    let num_lu_slots = LookupGate::num_slots(&common_data.config);
    let num_lut_slots = LookupTableGate::num_slots(&common_data.config);
    let lu_degree = common_data.lookup_accumulator_degree();
    let num_sldc_polys = local_lookup_zs.len() - 1;
    let lut_degree = num_lut_slots.div_ceil(num_sldc_polys);

    let mut constraints = Vec::with_capacity(4 + common_data.luts.len() + 2 * num_sldc_polys);

    // RE is the first polynomial stored.
    let z_re = local_lookup_zs[0];
    let next_z_re = next_lookup_zs[0];

    // Partial Sums and LDCs are both stored in the remaining SLDC polynomials.
    let z_x_lookup_sldcs = &local_lookup_zs[1..num_sldc_polys + 1];
    let z_gx_lookup_sldcs = &next_lookup_zs[1..num_sldc_polys + 1];

    let delta_challenge_a = F::Extension::from(deltas[LookupChallenges::ChallengeA as usize]);
    let delta_challenge_b = F::Extension::from(deltas[LookupChallenges::ChallengeB as usize]);

    // Compute all current looked and looking combos, i.e. the combos we need for the SLDC polynomials.
    let current_looked_combos: Vec<F::Extension> = (0..num_lut_slots)
        .map(|s| {
            let input_wire = vars.local_wires[LookupTableGate::wire_ith_looked_inp(s)];
            let output_wire = vars.local_wires[LookupTableGate::wire_ith_looked_out(s)];
            input_wire + delta_challenge_a * output_wire
        })
        .collect();

    let current_looking_combos: Vec<F::Extension> = (0..num_lu_slots)
        .map(|s| {
            let input_wire = vars.local_wires[LookupGate::wire_ith_looking_inp(s)];
            let output_wire = vars.local_wires[LookupGate::wire_ith_looking_out(s)];
            input_wire + delta_challenge_a * output_wire
        })
        .collect();

    // Compute all current lookup combos, i.e. the combos used to check that the LUT is correct.
    let current_lookup_combos: Vec<F::Extension> = (0..num_lut_slots)
        .map(|s| {
            let input_wire = vars.local_wires[LookupTableGate::wire_ith_looked_inp(s)];
            let output_wire = vars.local_wires[LookupTableGate::wire_ith_looked_out(s)];
            input_wire + delta_challenge_b * output_wire
        })
        .collect();

    // Check last LDC constraint.
    constraints.push(
        lookup_selectors[LookupSelectors::LastLdc as usize] * z_x_lookup_sldcs[num_sldc_polys - 1],
    );

    // Check initial Sum constraint.
    constraints.push(lookup_selectors[LookupSelectors::InitSre as usize] * z_x_lookup_sldcs[0]);

    // Check initial RE constraint.
    constraints.push(lookup_selectors[LookupSelectors::InitSre as usize] * z_re);

    let current_delta = deltas[LookupChallenges::ChallengeDelta as usize];

    // Check final RE constraints for each different LUT.
    for r in LookupSelectors::StartEnd as usize..common_data.num_lookup_selectors {
        let cur_ends_selector = lookup_selectors[r];
        let lut_row_number = common_data.luts[r - LookupSelectors::StartEnd as usize]
            .len()
            .div_ceil(num_lut_slots);
        let cur_function_eval = get_lut_poly(
            common_data,
            r - LookupSelectors::StartEnd as usize,
            deltas,
            num_lut_slots * lut_row_number,
        )
        .eval(current_delta);

        constraints.push(cur_ends_selector * (z_re - cur_function_eval.into()))
    }

    // Check RE row transition constraint.
    let mut cur_sum = next_z_re;
    for elt in &current_lookup_combos {
        cur_sum =
            cur_sum * F::Extension::from(deltas[LookupChallenges::ChallengeDelta as usize]) + *elt;
    }
    let unfiltered_re_line = z_re - cur_sum;

    constraints.push(lookup_selectors[LookupSelectors::TransSre as usize] * unfiltered_re_line);

    for poly in 0..num_sldc_polys {
        // Compute prod(alpha - combo) for the current slot for Sum.
        let lut_prod: F::Extension = (poly * lut_degree
            ..min((poly + 1) * lut_degree, num_lut_slots))
            .map(|i| {
                F::Extension::from(deltas[LookupChallenges::ChallengeAlpha as usize])
                    - current_looked_combos[i]
            })
            .product();

        // Compute prod(alpha - combo) for the current slot for LDC.
        let lu_prod: F::Extension = (poly * lu_degree..min((poly + 1) * lu_degree, num_lu_slots))
            .map(|i| {
                F::Extension::from(deltas[LookupChallenges::ChallengeAlpha as usize])
                    - current_looking_combos[i]
            })
            .product();

        // Function which computes, given index i: prod_{j!=i}(alpha - combo_j) for Sum.
        let lut_prod_i = |i| {
            (poly * lut_degree..min((poly + 1) * lut_degree, num_lut_slots))
                .map(|j| {
                    if j != i {
                        F::Extension::from(deltas[LookupChallenges::ChallengeAlpha as usize])
                            - current_looked_combos[j]
                    } else {
                        F::Extension::ONE
                    }
                })
                .product()
        };

        // Function which computes, given index i: prod_{j!=i}(alpha - combo_j) for LDC.
        let lu_prod_i = |i| {
            (poly * lu_degree..min((poly + 1) * lu_degree, num_lu_slots))
                .map(|j| {
                    if j != i {
                        F::Extension::from(deltas[LookupChallenges::ChallengeAlpha as usize])
                            - current_looking_combos[j]
                    } else {
                        F::Extension::ONE
                    }
                })
                .product()
        };
        // Compute sum_i(prod_{j!=i}(alpha - combo_j)) for LDC.
        let lu_sum_prods = (poly * lu_degree..min((poly + 1) * lu_degree, num_lu_slots))
            .fold(F::Extension::ZERO, |acc, i| acc + lu_prod_i(i));

        // Compute sum_i(mul_i.prod_{j!=i}(alpha - combo_j)) for Sum.
        let lut_sum_prods_with_mul = (poly * lut_degree
            ..min((poly + 1) * lut_degree, num_lut_slots))
            .fold(F::Extension::ZERO, |acc, i| {
                acc + vars.local_wires[LookupTableGate::wire_ith_multiplicity(i)] * lut_prod_i(i)
            });

        // The previous element is the previous poly of the current row or the last poly of the next row.
        let prev = if poly == 0 {
            z_gx_lookup_sldcs[num_sldc_polys - 1]
        } else {
            z_x_lookup_sldcs[poly - 1]
        };

        // Check Sum row and col transitions. It's the same constraint, with a row transition happening for slot == 0.
        let unfiltered_sum_transition =
            lut_prod * (z_x_lookup_sldcs[poly] - prev) - lut_sum_prods_with_mul;
        constraints
            .push(lookup_selectors[LookupSelectors::TransSre as usize] * unfiltered_sum_transition);

        // Check LDC row and col transitions. It's the same constraint, with a row transition happening for slot == 0.
        let unfiltered_ldc_transition = lu_prod * (z_x_lookup_sldcs[poly] - prev) + lu_sum_prods;
        constraints
            .push(lookup_selectors[LookupSelectors::TransLdc as usize] * unfiltered_ldc_transition);
    }

    constraints
}

/// Evaluates all gate constraints.
///
/// `num_gate_constraints` is the largest number of constraints imposed by any gate. It is not
/// strictly necessary, but it helps performance by ensuring that we allocate a vector with exactly
/// the capacity that we need.
pub fn evaluate_gate_constraints<F: RichField + Extendable<D>, const D: usize>(
    common_data: &CommonCircuitData<F, D>,
    vars: EvaluationVars<F, D>,
) -> Vec<F::Extension> {
    let mut constraints = vec![F::Extension::ZERO; common_data.num_gate_constraints];
    for (i, gate) in common_data.gates.iter().enumerate() {
        let selector_index = common_data.selectors_info.selector_indices[i];
        let gate_constraints = gate.0.eval_filtered(
            vars,
            i,
            selector_index,
            common_data.selectors_info.groups[selector_index].clone(),
            common_data.selectors_info.num_selectors(),
            common_data.num_lookup_selectors,
        );
        for (i, c) in gate_constraints.into_iter().enumerate() {
            debug_assert!(
                i < common_data.num_gate_constraints,
                "num_constraints() gave too low of a number"
            );
            constraints[i] += c;
        }
    }
    constraints
}
