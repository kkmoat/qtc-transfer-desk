/*!
 * This benchmark demonstrates a simple mode algorithm and how it can potentially be optimized with
 * loop unrolling.
 */
#[macro_use]
extern crate criterion;

use criterion::{Criterion, Fun};
use rand::distributions::{Distribution, Standard, Uniform};
use rand::prelude::*;
use unroll::unroll_for_loops;

static SEED: [u8; 32] = [3; 32];
const LEN: usize = 524_288;
// IMPORTANT:
// The largest integer generated can drastically change the characteristics of the benchmark.
// Most likely the larger the bins array, the smaller the performance benefit of loop
// unrolling since large bin arrays may not all fit into memory cache as well.
const MAX_INT: usize = 100;

#[inline]
fn make_random_vec(len: usize) -> Vec<usize>
where
    Standard: Distribution<usize>,
{
    let between = Uniform::from(0..MAX_INT);
    let mut rng: StdRng = SeedableRng::from_seed(SEED);
    (0..len).map(|_| between.sample(&mut rng)).collect()
}

#[inline]
#[unroll_for_loops]
fn unrolled_inner_mode4(data: &[usize]) -> (usize, usize) {
    let n = data.iter().cloned().max().map(|x| x + 1).unwrap_or(0);
    let mut bins = vec![[0; 4]; n];

    for i in (0..data.len()).step_by(4) {
        for j in 0..4 {
            bins[data[i+j]][j] += 1;
        }
    }

    bins.into_iter().map(|f| f.iter().sum()).enumerate().max_by_key(|&(_, f)| f).unwrap_or((0, 0))
}

#[inline]
#[unroll_for_loops]
fn unrolled_inner_mode32(data: &[usize]) -> (usize, usize) {
    let n = data.iter().cloned().max().map(|x| x + 1).unwrap_or(0);
    let mut bins = vec![[0; 32]; n];

    for i in (0..data.len()).step_by(32) {
        for j in 0..32 {
            bins[data[i+j]][j] += 1;
        }
    }

    bins.into_iter().map(|f| f.iter().sum()).enumerate().max_by_key(|&(_, f)| f).unwrap_or((0, 0))
}

#[inline]
fn unrolled_mode(data: &[usize]) -> (usize, usize) {
    let n = data.iter().cloned().max().map(|x| x + 1).unwrap_or(0);
    let mut bins = vec![[0; 32]; n];

    for i in (0..data.len()).step_by(32) {
        for j in 0..32 {
            bins[data[i+j]][j] += 1;
        }
    }

    bins.into_iter().map(|f| f.iter().sum()).enumerate().max_by_key(|&(_, f)| f).unwrap_or((0, 0))
}

#[inline]
fn explicit_mode(data: &[usize]) -> (usize, usize) {
    let mut bins = vec![0; data.iter().cloned().max().map(|x| x + 1).unwrap_or(0)];
    for &x in data.iter() {
        bins[x] += 1;
    }
    bins.iter().cloned().enumerate().max_by_key(|&(_, f)| f).unwrap_or((0, 0))
}

// Make sure the two implementations return the same results and are correct.
fn test_mode_implementations() {
    let v = vec![1, 1, 1, 0, 0, 0, 0, 1, 2, 2, 1, 0, 1, 2];
    assert_eq!(explicit_mode(&v), (1, 6));
    let v = vec![];
    assert_eq!(explicit_mode(&v), (0, 0));
    let v = vec![0, 0, 0, 1, 1, 1, 1, 2, 2, 2];
    assert_eq!(explicit_mode(&v), (1, 4));

    let v = make_random_vec(LEN);

    assert_eq!(explicit_mode(&v), unrolled_mode(&v));
    assert_eq!(explicit_mode(&v), unrolled_inner_mode4(&v));
    assert_eq!(explicit_mode(&v), unrolled_inner_mode32(&v));
}


fn unroll_mode(c: &mut Criterion) {
    test_mode_implementations();

    let explicit_mode = Fun::new("Explicit Mode", move |b, _| {
        let v = make_random_vec(LEN);
        b.iter(|| explicit_mode(&v))
    });

    let unrolled_mode = Fun::new("Unrolled Mode", move |b, _| {
        let v = make_random_vec(LEN);
        b.iter(|| unrolled_mode(&v))
    });

    let unrolled_inner_mode4 = Fun::new("Unrolled Inner Mode 4", move |b, _| {
        let v = make_random_vec(LEN);
        b.iter(|| unrolled_inner_mode4(&v))
    });

    let unrolled_inner_mode32 = Fun::new("Unrolled Inner Mode 32", move |b, _| {
        let v = make_random_vec(LEN);
        b.iter(|| unrolled_inner_mode32(&v))
    });

    let fns = vec![
        explicit_mode,
        unrolled_mode,
        unrolled_inner_mode4,
        unrolled_inner_mode32,
    ];
    c.bench_functions("Unroll Mode", fns, ());
}

criterion_group!(benches, unroll_mode);
criterion_main!(benches);
