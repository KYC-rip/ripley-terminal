//! Pure canonical-checkpoint invariants. Cursor is first unscanned block.
pub const RETAIN: usize = 64;
pub fn validate(cursor:u64,floor:u64,anchors:&[(u64,String)]) -> Result<(), &'static str> {
 if cursor<floor{return Err("cursor precedes restore floor")}
 if cursor==floor {return if anchors.is_empty(){Ok(())}else{Err("unexpected anchors at restore floor")}}
 if anchors.is_empty()||anchors.len()>RETAIN{return Err("missing/oversized checkpoint history")}
 let first=anchors[0].0;
 if first!=floor.max(cursor.saturating_sub(RETAIN as u64)){return Err("checkpoint history truncated")}
 for (i,(h,hash)) in anchors.iter().enumerate(){
  if *h!=first+i as u64||hash.len()!=64||!hash.bytes().all(|b|b.is_ascii_hexdigit()){return Err("invalid checkpoint chain")}
 }
 if anchors.last().unwrap().0.checked_add(1)!=Some(cursor){return Err("checkpoint/cursor mismatch")}
 Ok(())
}
pub fn rollback(cursor:u64,floor:u64,anchors:&[(u64,String)],remote:&[(u64,String)],tip:u64)->Result<u64,&'static str>{
 validate(cursor,floor,anchors)?;
 if cursor==floor {return if tip>=floor{Ok(cursor)}else{Err("chain below restore floor; explicit rescan required")}}
 for (h,hash) in anchors.iter().rev(){
  if *h>=tip{continue}
  let got=remote.iter().find(|(n,_)|n==h).ok_or("canonical header unavailable")?;
  if &got.1==hash{return Ok(h+1)}
 }
 // Genesis is retained only when floor=0 and history reaches it. Never silently
 // reset past a missing anchor: old outputs/spends must not survive a deep fork.
 Err("fork exceeds retained history; explicit rescan required")
}
#[cfg(test)]mod tests{use super::*;fn h(n:u64)->String{format!("{n:064x}")}fn a(n:u64)->Vec<(u64,String)>{(0..n).map(|i|(i,h(i))).collect()}
#[test]fn unchanged(){assert_eq!(rollback(4,0,&a(4),&a(4),4),Ok(4));}
#[test]fn same_height_fork(){let mut r=a(4);r[3].1=h(99);assert_eq!(rollback(4,0,&a(4),&r,4),Ok(3));}
#[test]fn shorter_tip(){assert_eq!(rollback(5,0,&a(5),&a(3),3),Ok(3));}
#[test]fn deeper_fork_fails(){assert!(rollback(5,0,&a(5),&vec![(0,h(99)),(1,h(99)),(2,h(99)),(3,h(99)),(4,h(99))],5).is_err());}
#[test]fn missing_remote_is_not_a_fork(){assert!(rollback(4,0,&a(4),&[],4).is_err());}
#[test]fn corrupt_cursor_fails(){assert!(validate(6,0,&a(5)).is_err());}
#[test]fn truncated_history_fails(){assert!(validate(5,0,&a(5)[1..]).is_err());}
#[test]fn reordered_fails(){let mut x=a(5);x.swap(1,2);assert!(validate(5,0,&x).is_err());}
#[test]fn retention_boundary(){let x:Vec<_>=(36..100).map(|i|(i,h(i))).collect();assert!(validate(100,0,&x).is_ok());let r=vec![(36,h(36))];assert_eq!(rollback(100,0,&x,&r,37),Ok(37));}
#[test]fn floor_and_empty(){assert_eq!(rollback(10,10,&[],&[],10),Ok(10));assert!(rollback(10,10,&[],&[],9).is_err());}
#[test]fn restart_after_rollback(){let x=a(3);assert!(validate(3,0,&x).is_ok());assert_eq!(rollback(3,0,&x,&a(5),5),Ok(3));}
#[test]fn invalid_hash(){let mut x=a(2);x[1].1="not-a-hash".into();assert!(validate(2,0,&x).is_err());}
}

pub fn advance_spend_verification(previous:Option<u64>,from:u64,to:u64,has_key:bool)->Option<u64>{
 if !has_key{return None} if to<from{return previous} if previous==Some(from){Some(to)}else{previous}
}
#[cfg(test)]mod spend_tests{use super::*;
#[test]fn absent_key_is_unverified(){assert_eq!(advance_spend_verification(Some(10),10,11,false),None);}
#[test]fn gap_never_falsely_advances(){assert_eq!(advance_spend_verification(Some(9),10,11,true),Some(9));}
#[test]fn unknown_does_not_become_verified(){assert_eq!(advance_spend_verification(None,10,11,true),None);}
#[test]fn actual_contiguous_observation_advances(){assert_eq!(advance_spend_verification(Some(10),10,11,true),Some(11));}
}
