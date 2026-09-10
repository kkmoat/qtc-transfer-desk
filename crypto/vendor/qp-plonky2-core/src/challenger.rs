#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

use crate::config::{GenericHashOut, Hasher};
use crate::field::extension::{Extendable, FieldExtension};
use crate::hash_types::{HashOut, RichField};
use crate::hashing::PlonkyPermutation;
use crate::merkle_tree::MerkleCap;

/// Observes prover messages, and generates challenges by hashing the transcript, a la Fiat-Shamir.
#[derive(Clone, Debug)]
pub struct Challenger<F: RichField, H: Hasher<F>> {
    pub(crate) sponge_state: H::Permutation,
    pub(crate) input_buffer: Vec<F>,
    output_buffer: Vec<F>,
}

/// Observes prover messages, and generates verifier challenges based on the transcript.
///
/// The implementation is roughly based on a duplex sponge with a Rescue permutation. Note that in
/// each round, our sponge can absorb an arbitrary number of prover messages and generate an
/// arbitrary number of verifier challenges. This might appear to diverge from the duplex sponge
/// design, but it can be viewed as a duplex sponge whose inputs are sometimes zero (when we perform
/// multiple squeezes) and whose outputs are sometimes ignored (when we perform multiple
/// absorptions). Thus the security properties of a duplex sponge still apply to our design.
impl<F: RichField, H: Hasher<F>> Challenger<F, H> {
    pub fn new() -> Challenger<F, H> {
        Challenger {
            sponge_state: H::Permutation::new(core::iter::repeat(F::ZERO)),
            input_buffer: Vec::with_capacity(H::Permutation::RATE),
            output_buffer: Vec::with_capacity(H::Permutation::RATE),
        }
    }

    pub fn observe_element(&mut self, element: F) {
        // Any buffered outputs are now invalid, since they wouldn't reflect this input.
        self.output_buffer.clear();

        self.input_buffer.push(element);

        if self.input_buffer.len() == H::Permutation::RATE {
            self.duplexing();
        }
    }

    pub fn observe_extension_element<const D: usize>(&mut self, element: &F::Extension)
    where
        F: RichField + Extendable<D>,
    {
        self.observe_elements(&element.to_basefield_array());
    }

    pub fn observe_elements(&mut self, elements: &[F]) {
        for &element in elements {
            self.observe_element(element);
        }
    }

    pub fn observe_extension_elements<const D: usize>(&mut self, elements: &[F::Extension])
    where
        F: RichField + Extendable<D>,
    {
        for element in elements {
            self.observe_extension_element(element);
        }
    }

    pub fn observe_hash<OH: Hasher<F>>(&mut self, hash: OH::Hash) {
        self.observe_elements(&hash.to_vec())
    }

    pub fn observe_cap<OH: Hasher<F>>(&mut self, cap: &MerkleCap<F, OH>) {
        for &hash in &cap.0 {
            self.observe_hash::<OH>(hash);
        }
    }

    pub fn get_challenge(&mut self) -> F {
        // If we have buffered inputs, we must perform a duplexing so that the challenge will
        // reflect them. Or if we've run out of outputs, we must perform a duplexing to get more.
        if !self.input_buffer.is_empty() || self.output_buffer.is_empty() {
            self.duplexing();
        }

        self.output_buffer
            .pop()
            .expect("Output buffer should be non-empty")
    }

    pub fn get_n_challenges(&mut self, n: usize) -> Vec<F> {
        (0..n).map(|_| self.get_challenge()).collect()
    }

    pub fn get_hash(&mut self) -> HashOut<F> {
        HashOut {
            elements: [
                self.get_challenge(),
                self.get_challenge(),
                self.get_challenge(),
                self.get_challenge(),
            ],
        }
    }

    pub fn get_extension_challenge<const D: usize>(&mut self) -> F::Extension
    where
        F: RichField + Extendable<D>,
    {
        let mut arr = [F::ZERO; D];
        arr.copy_from_slice(&self.get_n_challenges(D));
        F::Extension::from_basefield_array(arr)
    }

    pub fn get_n_extension_challenges<const D: usize>(&mut self, n: usize) -> Vec<F::Extension>
    where
        F: RichField + Extendable<D>,
    {
        (0..n)
            .map(|_| self.get_extension_challenge::<D>())
            .collect()
    }

    /// Absorb any buffered inputs. After calling this, the input buffer will be empty, and the
    /// output buffer will be full.
    fn duplexing(&mut self) {
        assert!(self.input_buffer.len() <= H::Permutation::RATE);

        // Overwrite the first r elements with the inputs. This differs from a standard sponge,
        // where we would xor or add in the inputs. This is a well-known variant, though,
        // sometimes called "overwrite mode".
        self.sponge_state
            .set_from_iter(self.input_buffer.drain(..), 0);

        // Apply the permutation.
        self.sponge_state.permute();

        self.output_buffer.clear();
        self.output_buffer
            .extend_from_slice(self.sponge_state.squeeze());
    }

    pub fn compact(&mut self) -> H::Permutation {
        if !self.input_buffer.is_empty() {
            self.duplexing();
        }
        self.output_buffer.clear();
        self.sponge_state
    }

    /// Returns a copy of the current sponge state.
    /// This is useful for proof-of-work calculations in the prover.
    pub fn sponge_state(&self) -> H::Permutation {
        self.sponge_state
    }

    /// Returns the current input buffer.
    /// This is useful for proof-of-work calculations in the prover.
    pub fn input_buffer(&self) -> &[F] {
        &self.input_buffer
    }
}

impl<F: RichField, H: Hasher<F>> Default for Challenger<F, H> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    #[cfg(not(feature = "std"))]
    use alloc::vec::Vec;

    use rand::rngs::SmallRng;
    use rand::SeedableRng;

    use crate::challenger::Challenger;
    use crate::config::{GenericConfig, PoseidonGoldilocksConfig};
    use crate::field::types::Sample;

    #[test]
    fn no_duplicate_challenges() {
        const D: usize = 2;
        type C = PoseidonGoldilocksConfig;
        type F = <C as GenericConfig<D>>::F;
        let mut challenger = Challenger::<F, <C as GenericConfig<D>>::InnerHasher>::new();
        let mut challenges = Vec::new();
        let mut rng = SmallRng::seed_from_u64(42);

        for i in 1..10 {
            challenges.extend(challenger.get_n_challenges(i));
            challenger.observe_element(F::sample(&mut rng));
        }

        let dedup_challenges = {
            let mut dedup = challenges.clone();
            dedup.dedup();
            dedup
        };
        assert_eq!(dedup_challenges, challenges);
    }
}
