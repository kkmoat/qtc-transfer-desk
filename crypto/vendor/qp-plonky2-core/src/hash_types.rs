//! Core hash output types used throughout plonky2.

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;
use core::fmt;

use anyhow::ensure;
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::field::goldilocks_field::GoldilocksField;
use crate::field::types::{Field, PrimeField64};
use crate::poseidon::Poseidon;

/// A prime order field with the features we need to use it as a base field in our argument system.
pub trait RichField: PrimeField64 + Poseidon {}

impl RichField for GoldilocksField {}

pub const NUM_HASH_OUT_ELTS: usize = 4;

/// Represents a ~256 bit hash output.
#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(bound = "")]
pub struct HashOut<F: Field> {
    pub elements: [F; NUM_HASH_OUT_ELTS],
}

impl<F: Field> HashOut<F> {
    pub const ZERO: Self = Self {
        elements: [F::ZERO; NUM_HASH_OUT_ELTS],
    };

    pub fn from_vec(elements: Vec<F>) -> Self {
        debug_assert!(elements.len() == NUM_HASH_OUT_ELTS);
        Self {
            elements: elements.try_into().unwrap(),
        }
    }

    pub fn from_partial(elements_in: &[F]) -> Self {
        let mut elements = [F::ZERO; NUM_HASH_OUT_ELTS];
        elements[0..elements_in.len()].copy_from_slice(elements_in);
        Self { elements }
    }
}

impl<F: Field> From<[F; NUM_HASH_OUT_ELTS]> for HashOut<F> {
    fn from(elements: [F; NUM_HASH_OUT_ELTS]) -> Self {
        Self { elements }
    }
}

impl<F: Field> TryFrom<&[F]> for HashOut<F> {
    type Error = anyhow::Error;

    fn try_from(elements: &[F]) -> Result<Self, Self::Error> {
        ensure!(elements.len() == NUM_HASH_OUT_ELTS);
        Ok(Self {
            elements: elements.try_into().unwrap(),
        })
    }
}

impl<F: Field> Default for HashOut<F> {
    fn default() -> Self {
        Self::ZERO
    }
}

#[cfg(feature = "rand")]
impl<F: Field + crate::field::types::Sample> crate::field::types::Sample for HashOut<F> {
    #[inline]
    fn sample<R>(rng: &mut R) -> Self
    where
        R: rand::Rng + ?Sized,
    {
        Self {
            elements: [
                F::sample(rng),
                F::sample(rng),
                F::sample(rng),
                F::sample(rng),
            ],
        }
    }
}

/// Hash consisting of a byte array.
#[derive(Eq, PartialEq, Copy, Clone, Debug)]
pub struct BytesHash<const N: usize>(pub [u8; N]);

impl<const N: usize> Serialize for BytesHash<N> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bytes(&self.0)
    }
}

struct ByteHashVisitor<const N: usize>;

impl<'de, const N: usize> Visitor<'de> for ByteHashVisitor<N> {
    type Value = BytesHash<N>;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        write!(formatter, "an array containing exactly {} bytes", N)
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: de::SeqAccess<'de>,
    {
        let mut bytes = [0u8; N];
        for i in 0..N {
            let next_element = seq.next_element()?;
            match next_element {
                Some(value) => bytes[i] = value,
                None => return Err(de::Error::invalid_length(i, &self)),
            }
        }
        Ok(BytesHash(bytes))
    }

    fn visit_bytes<E>(self, s: &[u8]) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        let bytes = s.try_into().unwrap();
        Ok(BytesHash(bytes))
    }
}

impl<'de, const N: usize> Deserialize<'de> for BytesHash<N> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_seq(ByteHashVisitor::<N>)
    }
}
