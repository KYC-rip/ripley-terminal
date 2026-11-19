#[path="../../src-tauri/src/wallet/time.rs"] mod shared;
#[test] fn shared_anchor_is_unchanged(){assert_eq!(shared::estimate_block_time(3_709_104),1_782_950_400);assert_eq!(shared::estimate_block_time(3_709_105),1_782_950_520);}
#[test] fn header_and_fallback_never_claim_future_time(){assert_eq!(shared::sent_time(300,0,200),200);assert_eq!(shared::sent_time(0,3_709_104,200),200);}
