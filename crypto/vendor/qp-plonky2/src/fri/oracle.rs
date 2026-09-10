#[cfg(not(feature = "std"))]
use alloc::{format, vec, vec::Vec};

use hashbrown::HashMap;
use itertools::Itertools;
use plonky2_field::types::Field;
use plonky2_maybe_rayon::*;

use crate::field::extension::Extendable;
use crate::field::fft::FftRootTable;
use crate::field::packed::PackedField;
use crate::field::polynomial::{PolynomialCoeffs, PolynomialValues};
use crate::fri::proof::FriProof;
use crate::fri::prover::fri_proof;
use crate::fri::structure::{FriBatchInfo, FriCoefficient, FriInstanceInfo, FriOpeningExpression};
use crate::fri::FriParams;
use crate::hash::hash_types::RichField;
use crate::hash::merkle_tree::MerkleTree;
use crate::iop::challenger::Challenger;
use crate::plonk::config::GenericConfig;
use crate::timed;
use crate::util::reducing::ReducingFactor;
use crate::util::timing::TimingTree;
use crate::util::{
    cached_point_power, log2_strict, reverse_bits, reverse_index_bits_in_place, transpose,
};

/// Four (~64 bit) field elements gives ~128 bit security.
pub const SALT_SIZE: usize = 4;

/// Represents a FRI oracle, i.e. a batch of polynomials which have been Merklized.
#[derive(Eq, PartialEq, Debug)]
pub struct PolynomialBatch<F: RichField + Extendable<D>, C: GenericConfig<D, F = F>, const D: usize>
{
    pub polynomials: Vec<PolynomialCoeffs<F>>,
    pub merkle_tree: MerkleTree<F, C::Hasher>,
    pub degree_log: usize,
    pub rate_bits: usize,
    pub blinding: bool,
}

impl<F: RichField + Extendable<D>, C: GenericConfig<D, F = F>, const D: usize> Default
    for PolynomialBatch<F, C, D>
{
    fn default() -> Self {
        PolynomialBatch {
            polynomials: Vec::new(),
            merkle_tree: MerkleTree::default(),
            degree_log: 0,
            rate_bits: 0,
            blinding: false,
        }
    }
}

impl<F: RichField + Extendable<D>, C: GenericConfig<D, F = F>, const D: usize>
    PolynomialBatch<F, C, D>
{
    fn eval_coefficient(
        coefficient: &FriCoefficient<F, D>,
        point: F::Extension,
        point_power_cache: &mut Vec<(usize, F::Extension)>,
    ) -> F::Extension {
        match coefficient {
            FriCoefficient::One => F::Extension::ONE,
            FriCoefficient::PointPower(power) => {
                cached_point_power(point, *power, point_power_cache)
            }
            FriCoefficient::Constant(constant) => *constant,
        }
    }

    fn repeated_opening_expression_polys(
        instance: &FriInstanceInfo<F, D>,
    ) -> HashMap<(usize, usize), usize> {
        let mut counts = HashMap::new();
        for batch in &instance.batches {
            for expression in &batch.openings {
                for term in &expression.terms {
                    let key = (
                        term.polynomial.oracle_index,
                        term.polynomial.polynomial_index,
                    );
                    *counts.entry(key).or_insert(0) += 1;
                }
            }
        }
        counts.retain(|_, count| *count > 1);
        counts
    }

    fn opening_expression_poly(
        expression: &FriOpeningExpression<F, D>,
        oracles: &[&Self],
        point: F::Extension,
        point_power_cache: &mut Vec<(usize, F::Extension)>,
        repeated_poly_counts: &HashMap<(usize, usize), usize>,
        converted_poly_cache: &mut HashMap<(usize, usize), PolynomialCoeffs<F::Extension>>,
    ) -> PolynomialCoeffs<F::Extension> {
        expression
            .terms
            .iter()
            .map(|term| {
                let coefficient =
                    Self::eval_coefficient(&term.coefficient, point, point_power_cache);
                let key = (
                    term.polynomial.oracle_index,
                    term.polynomial.polynomial_index,
                );
                let poly = &oracles[key.0].polynomials[key.1];
                let mut scaled = if repeated_poly_counts.contains_key(&key) {
                    converted_poly_cache
                        .entry(key)
                        .or_insert_with(|| poly.to_extension::<D>())
                        .clone()
                } else if coefficient == F::Extension::ONE {
                    poly.to_extension::<D>()
                } else {
                    poly.mul_extension::<D>(coefficient)
                };
                if repeated_poly_counts.contains_key(&key) && coefficient != F::Extension::ONE {
                    scaled *= coefficient;
                }
                scaled
            })
            .sum()
    }

    fn reduce_openings_to_unmasked_final_poly(
        instance: &FriInstanceInfo<F, D>,
        oracles: &[&Self],
        challenger: &mut Challenger<F, C::Hasher>,
        timing: &mut TimingTree,
    ) -> PolynomialCoeffs<F::Extension> {
        assert!(D > 1, "Not implemented for D=1.");
        let alpha = challenger.get_extension_challenge::<D>();
        let mut alpha = ReducingFactor::new(alpha);
        let repeated_poly_counts = Self::repeated_opening_expression_polys(instance);
        let mut converted_poly_cache = HashMap::with_capacity(repeated_poly_counts.len());

        let mut final_poly = PolynomialCoeffs::empty();
        for FriBatchInfo { point, openings } in &instance.batches {
            let mut point_power_cache = Vec::new();
            let composition_poly = timed!(
                timing,
                &format!("reduce batch of {} opening expressions", openings.len()),
                alpha.reduce_polys(openings.iter().map(|expr| {
                    Self::opening_expression_poly(
                        expr,
                        oracles,
                        *point,
                        &mut point_power_cache,
                        &repeated_poly_counts,
                        &mut converted_poly_cache,
                    )
                }))
            );
            let mut quotient = composition_poly.divide_by_linear(*point);
            quotient.coeffs.push(F::Extension::ZERO); // pad back to power of two
            alpha.shift_poly(&mut final_poly);
            final_poly += quotient;
        }

        final_poly
    }

    /// Creates a list polynomial commitment for the polynomials interpolating the values in `values`.
    pub fn from_values(
        values: Vec<PolynomialValues<F>>,
        rate_bits: usize,
        blinding: bool,
        cap_height: usize,
        timing: &mut TimingTree,
        fft_root_table: Option<&FftRootTable<F>>,
    ) -> Self {
        let coeffs = timed!(
            timing,
            "IFFT",
            values.into_par_iter().map(|v| v.ifft()).collect::<Vec<_>>()
        );

        Self::from_coeffs(
            coeffs,
            rate_bits,
            blinding,
            cap_height,
            timing,
            fft_root_table,
        )
    }

    /// Creates a list polynomial commitment for the polynomials `polynomials`.
    pub fn from_coeffs(
        polynomials: Vec<PolynomialCoeffs<F>>,
        rate_bits: usize,
        blinding: bool,
        cap_height: usize,
        timing: &mut TimingTree,
        fft_root_table: Option<&FftRootTable<F>>,
    ) -> Self {
        let degree = polynomials[0].len();
        let lde_values = timed!(
            timing,
            "FFT + blinding",
            Self::lde_values(&polynomials, rate_bits, blinding, fft_root_table)
        );

        let mut leaves = timed!(timing, "transpose LDEs", transpose(&lde_values));
        reverse_index_bits_in_place(&mut leaves);
        let merkle_tree = timed!(
            timing,
            "build Merkle tree",
            MerkleTree::new(leaves, cap_height)
        );

        Self {
            polynomials,
            merkle_tree,
            degree_log: log2_strict(degree),
            rate_bits,
            blinding,
        }
    }

    pub(crate) fn lde_values(
        polynomials: &[PolynomialCoeffs<F>],
        rate_bits: usize,
        blinding: bool,
        fft_root_table: Option<&FftRootTable<F>>,
    ) -> Vec<Vec<F>> {
        if blinding {
            #[cfg(feature = "rand")]
            return Self::lde_blinded_values(polynomials, rate_bits, fft_root_table);
            #[cfg(not(feature = "rand"))]
            {
                panic!("Cannot set blinding without rand feature");
            }
        } else {
            Self::lde_unblinded_values(polynomials, rate_bits, fft_root_table)
        }
    }

    #[cfg(feature = "rand")]
    fn lde_blinded_values(
        polynomials: &[PolynomialCoeffs<F>],
        rate_bits: usize,
        fft_root_table: Option<&FftRootTable<F>>,
    ) -> Vec<Vec<F>> {
        let degree = polynomials[0].len();

        polynomials
            .par_iter()
            .map(|p| {
                assert_eq!(p.len(), degree, "Polynomial degrees inconsistent");
                p.lde(rate_bits)
                    .coset_fft_with_options(F::coset_shift(), Some(rate_bits), fft_root_table)
                    .values
            })
            .chain(
                (0..SALT_SIZE)
                    .into_par_iter()
                    .map(|_| F::rand_vec(degree << rate_bits)),
            )
            .collect()
    }

    fn lde_unblinded_values(
        polynomials: &[PolynomialCoeffs<F>],
        rate_bits: usize,
        fft_root_table: Option<&FftRootTable<F>>,
    ) -> Vec<Vec<F>> {
        let degree = polynomials[0].len();

        polynomials
            .par_iter()
            .map(|p| {
                assert_eq!(p.len(), degree, "Polynomial degrees inconsistent");
                p.lde(rate_bits)
                    .coset_fft_with_options(F::coset_shift(), Some(rate_bits), fft_root_table)
                    .values
            })
            .collect()
    }

    /// Fetches LDE values at the `index * step`th point.
    pub fn get_lde_values(&self, index: usize, step: usize) -> &[F] {
        let index = index * step;
        let index = reverse_bits(index, self.degree_log + self.rate_bits);
        let slice = &self.merkle_tree.leaves[index];
        &slice[..slice.len() - if self.blinding { SALT_SIZE } else { 0 }]
    }

    /// Like `get_lde_values`, but fetches LDE values from a batch of `P::WIDTH` points, and returns
    /// packed values.
    pub fn get_lde_values_packed<P>(&self, index_start: usize, step: usize) -> Vec<P>
    where
        P: PackedField<Scalar = F>,
    {
        let row_wise = (0..P::WIDTH)
            .map(|i| self.get_lde_values(index_start + i, step))
            .collect_vec();

        // This is essentially a transpose, but we will not use the generic transpose method as we
        // want inner lists to be of type P, not Vecs which would involve allocation.
        let leaf_size = row_wise[0].len();
        (0..leaf_size)
            .map(|j| {
                let mut packed = P::ZEROS;
                packed
                    .as_slice_mut()
                    .iter_mut()
                    .zip(&row_wise)
                    .for_each(|(packed_i, row_i)| *packed_i = row_i[j]);
                packed
            })
            .collect_vec()
    }

    /// Produces a batch opening proof.
    pub fn prove_openings(
        instance: &FriInstanceInfo<F, D>,
        oracles: &[&Self],
        challenger: &mut Challenger<F, C::Hasher>,
        fri_params: &FriParams,
        final_poly_coeff_len: Option<usize>,
        max_num_query_steps: Option<usize>,
        timing: &mut TimingTree,
    ) -> FriProof<F, C::Hasher, D> {
        let final_poly_coeffs =
            Self::reduce_openings_to_unmasked_final_poly(instance, oracles, challenger, timing);

        // Compute LDE
        let lde_size = fri_params.lde_size();
        assert!(
            final_poly_coeffs.len() <= lde_size,
            "Final polynomial exceeded the configured LDE size"
        );
        let lde_coeffs = final_poly_coeffs.padded(lde_size);
        let lde_values = timed!(
            timing,
            &format!("perform final FFT {}", lde_size),
            lde_coeffs.coset_fft(F::coset_shift().into())
        );

        fri_proof::<F, C, D>(
            &oracles
                .par_iter()
                .map(|c| &c.merkle_tree)
                .collect::<Vec<_>>(),
            lde_coeffs,
            lde_values,
            challenger,
            fri_params,
            final_poly_coeff_len,
            max_num_query_steps,
            timing,
        )
    }
}

#[cfg(test)]
mod tests {
    use anyhow::Result;

    use super::PolynomialBatch;
    use crate::field::extension::Extendable;
    use crate::field::polynomial::PolynomialValues;
    use crate::field::types::Field;
    use crate::fri::proof::{FriChallenges, FriProof};
    use crate::fri::structure::{
        FriBatchInfo, FriOpeningBatch, FriOpeningExpression, FriOpenings, FriOracleInfo,
        FriPolynomialInfo,
    };
    use crate::fri::verifier::verify_fri_proof;
    use crate::fri::{FriChallenger, FriConfig, FriParams, FriReductionStrategy};
    use crate::iop::challenger::Challenger;
    use crate::plonk::config::{GenericConfig, PoseidonGoldilocksConfig};
    use crate::util::timing::TimingTree;

    const D: usize = 2;
    type C = PoseidonGoldilocksConfig;
    type F = <C as GenericConfig<D>>::F;
    type FE = <F as Extendable<D>>::Extension;
    type H = <C as GenericConfig<D>>::Hasher;

    fn test_fri_params() -> FriParams {
        FriParams {
            config: FriConfig {
                rate_bits: 1,
                cap_height: 0,
                proof_of_work_bits: 0,
                reduction_strategy: FriReductionStrategy::Fixed(vec![1, 1]),
                num_query_rounds: 4,
            },
            leaf_hiding: false,
            degree_bits: 4,
            reduction_arity_bits: vec![1, 1],
        }
    }

    fn test_oracle_and_instance(
        fri_params: &FriParams,
    ) -> (
        PolynomialBatch<F, C, D>,
        crate::fri::structure::FriInstanceInfo<F, D>,
        FriOpenings<F, D>,
        FE,
    ) {
        let mut timing = TimingTree::default();
        let trace = PolynomialValues::new(
            (0..(1 << fri_params.degree_bits))
                .map(F::from_canonical_usize)
                .collect(),
        );
        let oracle = PolynomialBatch::<F, C, D>::from_values(
            vec![trace],
            fri_params.config.rate_bits,
            false,
            fri_params.config.cap_height,
            &mut timing,
            None,
        );

        let mut challenger = Challenger::<F, H>::new();
        challenger.observe_cap(&oracle.merkle_tree.cap);
        let zeta = challenger.get_extension_challenge::<D>();
        let opening = oracle.polynomials[0].to_extension::<D>().eval(zeta);
        let instance = crate::fri::structure::FriInstanceInfo {
            oracles: vec![FriOracleInfo {
                num_polys: 1,
                blinding: false,
            }],
            batches: vec![FriBatchInfo {
                point: zeta,
                openings: vec![FriOpeningExpression::raw(FriPolynomialInfo {
                    oracle_index: 0,
                    polynomial_index: 0,
                })],
            }],
        };
        let openings = FriOpenings {
            batches: vec![FriOpeningBatch {
                values: vec![opening],
            }],
        };

        (oracle, instance, openings, zeta)
    }

    fn compute_fri_challenges(
        oracle: &PolynomialBatch<F, C, D>,
        openings: &FriOpenings<F, D>,
        proof: &FriProof<F, H, D>,
        fri_params: &FriParams,
    ) -> FriChallenges<F, D> {
        let mut challenger = Challenger::<F, H>::new();
        challenger.observe_cap(&oracle.merkle_tree.cap);
        let _zeta = challenger.get_extension_challenge::<D>();
        challenger.observe_openings(openings);
        challenger.fri_challenges::<C, D>(
            &proof.commit_phase_merkle_caps,
            &proof.final_poly,
            proof.pow_witness,
            fri_params.degree_bits,
            &fri_params.config,
            None,
            None,
        )
    }

    #[test]
    fn basic_fri_proof_verification() -> Result<()> {
        let fri_params = test_fri_params();
        let (oracle, instance, openings, _zeta) = test_oracle_and_instance(&fri_params);
        let mut timing = TimingTree::default();
        let mut prover_challenger = Challenger::<F, H>::new();
        prover_challenger.observe_cap(&oracle.merkle_tree.cap);
        let _ = prover_challenger.get_extension_challenge::<D>();
        prover_challenger.observe_openings(&openings);

        let proof = PolynomialBatch::<F, C, D>::prove_openings(
            &instance,
            &[&oracle],
            &mut prover_challenger,
            &fri_params,
            None,
            None,
            &mut timing,
        );
        let fri_challenges = compute_fri_challenges(&oracle, &openings, &proof, &fri_params);
        verify_fri_proof::<F, C, D>(
            &instance,
            &openings,
            &fri_challenges,
            &[oracle.merkle_tree.cap.clone()],
            &proof,
            &fri_params,
        )?;

        Ok(())
    }
}
