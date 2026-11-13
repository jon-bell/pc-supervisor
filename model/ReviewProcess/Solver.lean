import ReviewProcess.Validate
import Std.Data.HashMap
/-
  Plan as a solver (docs/spec.md §10.5): min-cost max-flow over the network

    source ─(one arc per unit of load; convex cost for PC members, 0 for a nominee
             up to what they owe)─► reviewer
    reviewer ─(cap 1, cost from affinity; only eligible, unforbidden candidates)─► paper slot
    paper.senior ─(cap 2)─► sink        paper.third ─(cap thirdSlots)─► sink

  Each reviewer feeds at most one slot kind of a paper (`fillsSenior` or
  `fillsThird`), so one integral solve is exact. Max flow fills as many slots as
  possible; among those, min cost prefers affinity, nominees up to what they
  owe, and balanced PC loads. Unfilled slots are reported per paper, the
  "soft first" behavior of §10.5. Reciprocal 2-cycles are repaired by
  forbidding the weaker edge of each cycle and solving again.

  The algorithm is primal-dual: Dijkstra on reduced costs, then blocking flows
  (Dinic) on the zero-reduced-cost arcs. The solver is the reference that the
  JVM implementation (`core`) is tested against; its safety (A2, V1) holds by construction:
  see `a2_plan_eligible`.
-/
namespace ReviewProcess

/-! ### Min-cost max-flow -/

structure Flow where
  n : Nat
  src : Array Nat
  dst : Array Nat
  cap : Array Int
  cost : Array Int
  start : Array Nat
  adj : Array Nat
  deriving Inhabited

/-- Arcs are (from, to, capacity, cost). Arc `i` of the input becomes arc `2i`;
    its residual reverse is `2i + 1`. -/
def Flow.build (n : Nat) (arcs : Array (Nat × Nat × Int × Int)) : Flow := Id.run do
  let m := arcs.size
  let mut src : Array Nat := Array.mkEmpty (2 * m)
  let mut dst : Array Nat := Array.mkEmpty (2 * m)
  let mut cap : Array Int := Array.mkEmpty (2 * m)
  let mut cost : Array Int := Array.mkEmpty (2 * m)
  for (u, v, c, w) in arcs do
    src := (src.push u).push v
    dst := (dst.push v).push u
    cap := (cap.push c).push 0
    cost := (cost.push w).push (-w)
  let mut start : Array Nat := Array.replicate (n + 1) 0
  for a in [0:2 * m] do start := start.modify (src[a]! + 1) (· + 1)
  for u in [0:n] do start := start.set! (u + 1) (start[u + 1]! + start[u]!)
  let mut pos := start
  let mut adj : Array Nat := Array.replicate (2 * m) 0
  for a in [0:2 * m] do
    let u := src[a]!
    adj := adj.set! pos[u]! a
    pos := pos.modify u (· + 1)
  return { n, src, dst, cap, cost, start, adj }

def heapPush (h : Array (Int × Nat)) (x : Int × Nat) : Array (Int × Nat) := Id.run do
  let mut h := h.push x
  let mut i := h.size - 1
  while i > 0 do
    let p := (i - 1) / 2
    if h[i]!.1 < h[p]!.1 then
      h := h.swapIfInBounds i p
      i := p
    else break
  return h

def heapPop (h : Array (Int × Nat)) : (Int × Nat) × Array (Int × Nat) := Id.run do
  let top := h[0]!
  let last := h.back!
  let mut h := h.pop
  if h.isEmpty then return (top, h)
  h := h.set! 0 last
  let n := h.size
  let mut i := 0
  while true do
    let l := 2 * i + 1
    let r := l + 1
    let mut m := i
    if l < n && h[l]!.1 < h[m]!.1 then m := l
    if r < n && h[r]!.1 < h[m]!.1 then m := r
    if m == i then break
    h := h.swapIfInBounds i m
    i := m
  return (top, h)

/-- Min-cost max-flow from `s` to `t`. Costs must be nonnegative. Returns the
    residual network, the flow value, and its cost. -/
def minCostMaxFlow (f : Flow) (s t : Nat) : Flow × Int × Int := Id.run do
  let inf : Int := 1000000000000
  let n := f.n
  let cost := f.cost
  let mut cap := f.cap
  let mut pot : Array Int := Array.replicate n 0
  let mut flow : Int := 0
  let mut total : Int := 0
  while true do
    let mut dist : Array Int := Array.replicate n inf
    dist := dist.set! s 0
    let mut heap : Array (Int × Nat) := #[(0, s)]
    while !heap.isEmpty do
      let ((d, u), h') := heapPop heap
      heap := h'
      if d > dist[u]! then continue
      for i in [f.start[u]!:f.start[u + 1]!] do
        let a := f.adj[i]!
        if cap[a]! > 0 then
          let v := f.dst[a]!
          let nd := d + cost[a]! + pot[u]! - pot[v]!
          if nd < dist[v]! then
            dist := dist.set! v nd
            heap := heapPush heap (nd, v)
    let dt := dist[t]!
    if dt ≥ inf then break
    for v in [0:n] do pot := pot.set! v (pot[v]! + min dist[v]! dt)
    -- blocking flows on the arcs of zero reduced cost
    while true do
      let mut level : Array Int := Array.replicate n (-1)
      level := level.set! s 0
      let mut queue : Array Nat := #[s]
      let mut qi := 0
      while qi < queue.size do
        let u := queue[qi]!
        qi := qi + 1
        for i in [f.start[u]!:f.start[u + 1]!] do
          let a := f.adj[i]!
          let v := f.dst[a]!
          if cap[a]! > 0 && level[v]! < 0 && cost[a]! + pot[u]! - pot[v]! == 0 then
            level := level.set! v (level[u]! + 1)
            queue := queue.push v
      if level[t]! < 0 then break
      let mut it := f.start
      let mut path : Array Nat := #[]
      let mut u := s
      while true do
        if u == t then
          let mut b : Int := inf
          for a in path do b := min b cap[a]!
          for a in path do
            cap := cap.modify a (· - b)
            cap := cap.modify (a ^^^ 1) (· + b)
            total := total + b * cost[a]!
          flow := flow + b
          path := #[]
          u := s
        else
          let mut found : Option Nat := none
          while it[u]! < f.start[u + 1]! do
            let a := f.adj[it[u]!]!
            let v := f.dst[a]!
            if cap[a]! > 0 && level[v]! == level[u]! + 1 && cost[a]! + pot[u]! - pot[v]! == 0 then
              found := some a
              break
            it := it.modify u (· + 1)
          match found with
          | some a =>
            path := path.push a
            u := f.dst[a]!
          | none =>
            if u == s then break
            level := level.set! u (-1)
            let a := path.back!
            path := path.pop
            u := f.src[a]!
            it := it.modify u (· + 1)
  return ({ f with cap }, flow, total)

/-! ### The assignment network for a conference -/

inductive Slot | senior | third
  deriving DecidableEq, Repr, Inhabited

structure Cand where
  who : PersonId
  paper : Nat
  slot : Slot
  aff : Nat
  deriving Repr, Inhabited

def Conf.member (c : Conf) (u : PersonId) : Member :=
  match c.pcTier[u]! with
  | some t => { who := u, tier := some t }
  | none => { who := u, tier := c.nomineeTier[u]!, nominee := true }

def Conf.facts (c : Conf) (pp : Nat) : PaperFacts := { authors := c.authors[pp]!, conflicts := [] }

def Conf.nAreas (c : Conf) : Nat := c.paperArea.foldl max 0 + 1

/-- Synthetic affinity on 0..100: high in the paper's area, low in a neighboring
    area, none elsewhere. -/
def Conf.affinity (c : Conf) (na u pp : Nat) : Option Nat :=
  let pa := c.paperArea[pp]!
  let ua := c.personArea[u]!
  if ua == pa then some (50 + hash2 u (pp + 7) % 51)
  else if ua == (pa + 1) % na || pa == (ua + 1) % na then some (hash2 u (pp + 7) % 40)
  else none

def topK : Nat := 25

/-- Candidates before eligibility: the best `topK` per paper slot by affinity. -/
def rawCands (c : Conf) (r : Reading) : Array Cand := Id.run do
  let na := c.nAreas
  let mut byArea : Array (List PersonId) := Array.replicate na []
  for u in [0:c.personArea.size] do
    if c.pcTier[u]!.isSome || c.nomineeTier[u]!.isSome then
      byArea := byArea.modify c.personArea[u]! (u :: ·)
  let mut out : Array Cand := #[]
  for pp in [0:c.nPapers] do
    let pa := c.paperArea[pp]!
    let pool := byArea[pa]! ++ byArea[(pa + 1) % na]! ++ byArea[(pa + na - 1) % na]!
    let mut sen : Array Cand := #[]
    let mut thd : Array Cand := #[]
    for u in pool do
      match c.affinity na u pp with
      | none => pure ()
      | some a =>
        let m := c.member u
        if fillsSenior r m then sen := sen.push { who := u, paper := pp, slot := .senior, aff := a }
        else if fillsThird r m then thd := thd.push { who := u, paper := pp, slot := .third, aff := a }
    for x in (sen.qsort (fun a b => a.aff > b.aff)).extract 0 topK do out := out.push x
    for x in (thd.qsort (fun a b => a.aff > b.aff)).extract 0 topK do out := out.push x
  return out

/-- The candidate edges the network may use: eligible (V1, A2) and not forbidden by a repair. -/
def cands (c : Conf) (forbidden : Std.HashMap (PersonId × Nat) Unit) (raw : List Cand) : List Cand :=
  raw.filter fun e => eligible {} (c.member e.who) (c.facts e.paper) && !forbidden.contains (e.who, e.paper)

/-- A plan's edges: the candidates the flow uses. -/
def planEdges (cs : List Cand) (used : Cand → Bool) : List Cand := cs.filter used

/-- A2 and V1 for the solver: whatever the flow, every planned edge is to an
    eligible reviewer (accepted, consented, classified, not an author, not
    conflicted) and not one a repair forbade. -/
theorem a2_plan_eligible (c : Conf) (fb : Std.HashMap (PersonId × Nat) Unit) (raw : List Cand)
    (used : Cand → Bool) (e : Cand) (h : e ∈ planEdges (cands c fb raw) used) :
    eligible {} (c.member e.who) (c.facts e.paper) = true ∧ fb.contains (e.who, e.paper) = false := by
  simp only [planEdges, cands, List.mem_filter, Bool.and_eq_true, Bool.not_eq_true'] at h
  exact h.1.2

/-- Load caps: the tier's band for PC members; for an accepted nominee, what
    they owe (rounded up), never above their band (V2). -/
def loadCaps (c : Conf) (r : Reading) : Array Nat × Array Nat := Id.run do
  let n := c.personArea.size
  let mut namedIn : Array (List PaperNoms) := Array.replicate n []
  for pp in [0:c.nPapers] do
    for x in c.nominees[pp]! do
      if x.accepted then namedIn := namedIn.modify x.who (· ++ [noms pp c.nominees[pp]!])
  let mut cap : Array Nat := Array.replicate n 0
  let mut owed : Array Nat := Array.replicate n 0
  for u in [0:n] do
    match c.pcTier[u]! with
    | some t => cap := cap.set! u (bandMax t)
    | none =>
      match c.nomineeTier[u]! with
      | some t =>
        let o := (owes {} r t namedIn[u]! u).getD (6 * k * namedIn[u]!.length)
        owed := owed.set! u o
        cap := cap.set! u (min (bandMax t) ((o + 5) / 6))
      | none => pure ()
  return (cap, owed)

structure Solved where
  plan : List Cand
  objective : Int
  filled : Nat

def solveOnce (c : Conf) (r : Reading) (cap : Array Nat) (cs : List Cand) : Solved := Id.run do
  let n := c.personArea.size
  let mut node : Array Nat := Array.replicate n 0       -- 0 = not in the network
  let mut nr := 0
  for u in [0:n] do
    if cap[u]! > 0 then
      nr := nr + 1
      node := node.set! u (1 + nr)
  let slotNode (pp : Nat) (sl : Slot) : Nat := 2 + nr + 2 * pp + (if sl == .senior then 0 else 1)
  let nNodes := 2 + nr + 2 * c.nPapers
  let mut arcs : Array (Nat × Nat × Int × Int) := #[]
  for u in [0:n] do
    if cap[u]! > 0 then
      let nominee := c.pcTier[u]!.isNone
      for i in [0:cap[u]!] do
        arcs := arcs.push (0, node[u]!, 1, if nominee then 0 else 1 + Int.ofNat i)
  let first := arcs.size
  let csA := cs.toArray
  for e in csA do
    arcs := arcs.push (node[e.who]!, slotNode e.paper e.slot, 1, Int.ofNat ((100 - e.aff) / 5))
  for pp in [0:c.nPapers] do
    arcs := arcs.push (slotNode pp .senior, 1, 2, 0)
    if thirdSlots r > 0 then arcs := arcs.push (slotNode pp .third, 1, Int.ofNat (thirdSlots r), 0)
  let (f, flow, total) := minCostMaxFlow (Flow.build nNodes arcs) 0 1
  let usedArr := (List.range csA.size).map fun j => f.cap[2 * (first + j)]! == 0
  let plan := (csA.toList.zip usedArr).filterMap fun (e, b) => if b then some e else none
  return { plan, objective := total, filled := flow.toNat }

/-- Reciprocal 2-cycles in a plan: (u reviews b, u wrote a) and (v reviews a, v wrote b). -/
def cyclesOf (c : Conf) (plan : List Cand) : List (Cand × Cand) := Id.run do
  let n := c.personArea.size
  let mut reviewsOf : Array (List Cand) := Array.replicate n []
  for e in plan do reviewsOf := reviewsOf.modify e.who (e :: ·)
  let mut papersOf : Array (List Nat) := Array.replicate n []
  for pp in [0:c.nPapers] do
    for u in c.authors[pp]! do papersOf := papersOf.modify u (pp :: ·)
  let mut out : List (Cand × Cand) := []
  for u in [0:n] do
    for e in reviewsOf[u]! do
      for a in papersOf[u]! do
        if a < e.paper then
          for v in c.authors[e.paper]! do
            for e' in reviewsOf[v]! do
              if e'.paper == a then out := (e, e') :: out
  return out

structure Outcome where
  composed : Nat := 0
  seniorShort : Nat := 0
  thirdShort : Nat := 0
  nominees : Nat := 0
  nomineeReviews : Nat := 0
  nomineesAtOwed : Nat := 0
  maxNomineeLoad : Nat := 0
  meanOwedSixths : Nat := 0
  seniorReviewsNeeded : Nat := 0
  seniorCapacity : Nat := 0
  cyclesFirst : Nat := 0
  repairs : Nat := 0
  cycles : Nat := 0
  loadViolations : Nat := 0
  crossArea : Nat := 0
  objective : Int := 0
  candidateEdges : Nat := 0
  earlyRejects : Nat := 0
  deriving Repr, Inhabited

def maxRepairRounds : Nat := 3

/-- Solve, repair reciprocal 2-cycles (up to `maxRepairRounds` rounds), and assess the plan. -/
def runConf (r : Reading) (c : Conf) : Outcome := Id.run do
  let n := c.personArea.size
  let (cap, owed) := loadCaps c r
  let raw := (rawCands c r).toList
  let mut forbidden : Std.HashMap (PersonId × Nat) Unit := {}
  let mut cs := cands c forbidden raw
  let mut sol := solveOnce c r cap cs
  let mut cyc := cyclesOf c sol.plan
  let cyclesFirst := cyc.length
  let mut repairs := 0
  for _ in [0:maxRepairRounds] do
    if cyc.isEmpty then break
    for (e, e') in cyc do
      let weak := if e.aff ≤ e'.aff then e else e'
      if !forbidden.contains (weak.who, weak.paper) then
        forbidden := forbidden.insert (weak.who, weak.paper) ()
        repairs := repairs + 1
    cs := cands c forbidden raw
    sol := solveOnce c r cap cs
    cyc := cyclesOf c sol.plan
  -- assess
  let mut seats : Array (List Member) := Array.replicate c.nPapers []
  let mut load : Array Nat := Array.replicate n 0
  let mut cross := 0
  for e in sol.plan do
    seats := seats.modify e.paper (c.member e.who :: ·)
    load := load.modify e.who (· + 1)
    if c.personArea[e.who]! != c.paperArea[e.paper]! then cross := cross + 1
  let mut out : Outcome := { cyclesFirst, repairs, cycles := cyc.length, crossArea := cross,
                             objective := sol.objective, candidateEdges := cs.length,
                             seniorReviewsNeeded := 2 * c.nPapers }
  for pp in [0:c.nPapers] do
    let ss := seats[pp]!
    let sen := (ss.filter (fillsSenior r)).length
    let thd := (ss.filter (fillsThird r)).length
    out := { out with seniorShort := out.seniorShort + (2 - min 2 sen),
                      thirdShort := out.thirdShort + (thirdSlots r - min (thirdSlots r) thd) }
    if compositionOk r ss then out := { out with composed := out.composed + 1 }
    if mayEarlyReject {} r { scores := c.scores[pp]!, windowClosed := true } then
      out := { out with earlyRejects := out.earlyRejects + 1 }
  let mut owedTotal := 0
  for u in [0:n] do
    if load[u]! > cap[u]! then out := { out with loadViolations := out.loadViolations + 1 }
    if c.pcTier[u]!.isNone && c.nomineeTier[u]!.isSome then
      owedTotal := owedTotal + owed[u]!
      out := { out with nominees := out.nominees + 1, nomineeReviews := out.nomineeReviews + load[u]!,
                        maxNomineeLoad := max out.maxNomineeLoad load[u]!,
                        nomineesAtOwed := out.nomineesAtOwed + (if 6 * load[u]! ≥ owed[u]! then 1 else 0) }
    if (c.pcTier[u]!.isSome || c.nomineeTier[u]!.isSome) && fillsSenior r (c.member u) then
      out := { out with seniorCapacity := out.seniorCapacity + cap[u]! }
  return { out with meanOwedSixths := if out.nominees == 0 then 0 else owedTotal / out.nominees }

/-! ### Self-check against brute force -/

/-- A small random bipartite instance: reviewers with load caps, papers with
    slot demands, edges with costs. Returns (max flow, min cost) by trying every
    subset of edges. -/
def bruteForce (caps demands : Array Nat) (edges : Array (Nat × Nat × Nat)) : Nat × Nat := Id.run do
  let m := edges.size
  let mut best : Nat × Nat := (0, 0)
  for mask in [0:2 ^ m] do
    let mut ld := Array.replicate caps.size 0
    let mut dm := Array.replicate demands.size 0
    let mut c := 0
    let mut cnt := 0
    for j in [0:m] do
      if (mask >>> j) % 2 == 1 then
        let (u, p, w) := edges[j]!
        ld := ld.modify u (· + 1)
        dm := dm.modify p (· + 1)
        c := c + w
        cnt := cnt + 1
    let ok := (List.range caps.size).all (fun u => ld[u]! ≤ caps[u]!) &&
              (List.range demands.size).all (fun p => dm[p]! ≤ demands[p]!)
    if ok && (cnt > best.1 || (cnt == best.1 && c < best.2)) then best := (cnt, c)
  return best

def viaFlow (caps demands : Array Nat) (edges : Array (Nat × Nat × Nat)) : Nat × Nat :=
  let nu := caps.size
  let arcs : Array (Nat × Nat × Int × Int) :=
    (caps.mapIdx fun u c => (0, 2 + u, Int.ofNat c, 0)) ++
    (edges.map fun (u, p, w) => (2 + u, 2 + nu + p, 1, Int.ofNat w)) ++
    (demands.mapIdx fun p d => (2 + nu + p, 1, Int.ofNat d, 0))
  let (_, fl, cost) := minCostMaxFlow (Flow.build (2 + nu + demands.size) arcs) 0 1
  (fl.toNat, cost.toNat)

/-- Number of random instances on which the flow and brute force disagree. -/
def selfCheck (trials : Nat := 300) : Nat × Nat := Id.run do
  let mut bad := 0
  for t in [0:trials] do
    let nu := 2 + hash2 t 1 % 3
    let np := 2 + hash2 t 2 % 3
    let caps := (Array.range nu).map fun u => 1 + hash2 t (10 + u) % 3
    let demands := (Array.range np).map fun p => 1 + hash2 t (20 + p) % 2
    let mut edges : Array (Nat × Nat × Nat) := #[]
    for u in [0:nu] do
      for p in [0:np] do
        if hash2 t (100 + 7 * u + p) % 3 != 0 && edges.size < 12 then
          edges := edges.push (u, p, hash2 t (200 + 7 * u + p) % 10)
    if viaFlow caps demands edges != bruteForce caps demands edges then bad := bad + 1
  return (trials, bad)

end ReviewProcess
