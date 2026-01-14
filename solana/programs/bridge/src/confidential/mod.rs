//! Confidential bridging module using Inco Lightning for encrypted transfers.
//!
//! This module provides privacy-preserving cross-chain transfers by using Inco's
//! encrypted types (Euint128, Ebool) to hide transfer amounts on both chains.

use anchor_lang::prelude::*;
use inco_lightning::cpi::accounts::{Allow, Operation};
use inco_lightning::cpi::{allow, e_add, e_ge, e_select, e_sub, new_euint128};
use inco_lightning::types::{Ebool, Euint128};
use inco_lightning::ID as INCO_LIGHTNING_ID;

pub mod vault;
pub mod instructions;

pub use vault::*;
pub use instructions::*;
