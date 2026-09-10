#[cfg(not(feature = "std"))]
use alloc::{
    string::{String, ToString},
    vec,
    vec::Vec,
};

use anyhow::{ensure, Result};

use crate::field::extension::Extendable;
use crate::hash::hash_types::RichField;
use crate::iop::generator::{GeneratedValues, SimpleGenerator};
use crate::iop::target::{BoolTarget, Target};
use crate::iop::witness::{PartitionWitness, Witness, WitnessWrite};
use crate::plonk::circuit_builder::CircuitBuilder;
use crate::plonk::circuit_data::CommonCircuitData;
use crate::util::serialization::{Buffer, IoResult, Read, Write};

impl<F: RichField + Extendable<D>, const D: usize> CircuitBuilder<F, D> {
    /// Checks that `x < 2^n_log` using a `BaseSumGate`.
    pub fn range_check(&mut self, x: Target, n_log: usize) {
        self.split_le(x, n_log);
    }

    /// Returns the first `num_low_bits` little-endian bits of `x`.
    pub fn low_bits(&mut self, x: Target, num_low_bits: usize, num_bits: usize) -> Vec<BoolTarget> {
        let mut res = self.split_le(x, num_bits);
        res.truncate(num_low_bits);
        res
    }

    /// Returns `(a,b)` such that `x = a + 2^n_log * b` with `a < 2^n_log`.
    /// `x` is assumed to be range-checked for having `num_bits` bits.
    pub fn split_low_high(&mut self, x: Target, n_log: usize, num_bits: usize) -> (Target, Target) {
        assert!(n_log <= num_bits, "n_log must not exceed num_bits");
        assert!(n_log < u64::BITS as usize, "n_log must be less than 64");
        assert!(
            num_bits <= u64::BITS as usize,
            "num_bits must be at most 64"
        );

        let low = self.add_virtual_target();
        let high = self.add_virtual_target();

        self.add_simple_generator(LowHighGenerator {
            integer: x,
            n_log,
            low,
            high,
        });

        self.range_check(low, n_log);
        let high_bits = num_bits - n_log;
        self.range_check(high, high_bits);

        let pow2 = 1u64
            .checked_shl(n_log as u32)
            .expect("n_log was validated to be less than 64");
        let pow2 = self.constant(F::from_canonical_u64(pow2));
        let comp_x = self.mul_add(high, pow2, low);
        self.connect(x, comp_x);

        (low, high)
    }

    pub fn assert_bool(&mut self, b: BoolTarget) {
        let z = self.mul_sub(b.target, b.target, b.target);
        let zero = self.zero();
        self.connect(z, zero);
    }
}

#[derive(Debug, Default)]
pub struct LowHighGenerator {
    integer: Target,
    n_log: usize,
    low: Target,
    high: Target,
}

impl<F: RichField + Extendable<D>, const D: usize> SimpleGenerator<F, D> for LowHighGenerator {
    fn id(&self) -> String {
        "LowHighGenerator".to_string()
    }

    fn dependencies(&self) -> Vec<Target> {
        vec![self.integer]
    }

    fn run_once(
        &self,
        witness: &PartitionWitness<F>,
        out_buffer: &mut GeneratedValues<F>,
    ) -> Result<()> {
        ensure!(
            self.n_log < u64::BITS as usize,
            "n_log must be less than 64"
        );
        let integer_value = witness.get_target(self.integer).to_canonical_u64();
        let low_mask = 1u64
            .checked_shl(self.n_log as u32)
            .expect("n_log was validated to be less than 64")
            - 1;
        let low = integer_value & low_mask;
        let high = integer_value >> self.n_log;

        out_buffer.set_target(self.low, F::from_canonical_u64(low))?;
        out_buffer.set_target(self.high, F::from_canonical_u64(high))
    }

    fn serialize(&self, dst: &mut Vec<u8>, _common_data: &CommonCircuitData<F, D>) -> IoResult<()> {
        dst.write_target(self.integer)?;
        dst.write_usize(self.n_log)?;
        dst.write_target(self.low)?;
        dst.write_target(self.high)
    }

    fn deserialize(src: &mut Buffer, _common_data: &CommonCircuitData<F, D>) -> IoResult<Self> {
        let integer = src.read_target()?;
        let n_log = src.read_usize()?;
        if n_log >= u64::BITS as usize {
            return Err(crate::util::serialization::IoError);
        }
        let low = src.read_target()?;
        let high = src.read_target()?;
        Ok(Self {
            integer,
            n_log,
            low,
            high,
        })
    }
}
