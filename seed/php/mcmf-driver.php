<?php
// mcmf-driver.php -- run HotCRP's MinCostMaxFlow on many instances (PLAN M10a).
//
// Runs INSIDE the harness's hotcrp container only (the differential test,
// server/test/integration/mcmf-differential.test.ts, copies it to
// /tmp/pcs-seed/ and pipes instances in). It loads lib/mincostmaxflow.php
// directly; that file needs nothing from HotCRP's bootstrap except
// Conf::$main->opt() for its debug file, which is stubbed below.
//
// stdin:  {"instances": [{"n": N, "edges": [[src, dst, cap, cost, mincap], ...]}, ...]}
//         Node 0 is ".source", node 1 is ".sink", nodes 2..N-1 are "v2"...
// stdout: one JSON line per instance:
//   {"status": "ok"|"infeasible"|"error"|"hung", "maxflow": int, "cost": int,
//    "flows": [int per edge], "conserving": bool, "bounded": bool,
//    "precision_limited": bool, "message"?: string}
// "hung" means the solver made no progress after the iteration budget
// (PHP loops forever on some lower-bound deficits). "conserving"/"bounded"
// check the returned flow: conservation at every vertex but the source and
// sink, and mincap <= flow <= cap on every edge.

if (!class_exists("Conf")) {
    class Conf {
        /** @var Conf */
        static public $main;
        /** @var int */
        static public $now = 0;
        /** @var string */
        public $dbname = "pcs";
        function opt($name) {
            return null;
        }
    }
    Conf::$main = new Conf;
}
require_once("/var/www/html/lib/mincostmaxflow.php");

class PcsMcmfHung extends Exception {
}

$input = json_decode(stream_get_contents(STDIN), true);
$budget = (int) ($input["max_progress"] ?? 200);
foreach ($input["instances"] as $inst) {
    $n = (int) $inst["n"];
    $edges = $inst["edges"];
    $out = ["status" => "ok", "maxflow" => 0, "cost" => 0, "flows" => [],
            "conserving" => true, "bounded" => true, "precision_limited" => false];
    $m = new MinCostMaxFlow;
    $names = [".source", ".sink"];
    for ($i = 2; $i < $n; ++$i) {
        $names[] = "v{$i}";
        $m->add_node("v{$i}", "v");
    }
    foreach ($edges as $e) {
        $m->add_edge($names[$e[0]], $names[$e[1]], (int) $e[2], (int) $e[3], (int) $e[4]);
    }
    $calls = 0;
    $m->add_progress_function(function ($mcmf, $what) use (&$calls, $budget) {
        if (++$calls > $budget) {
            throw new PcsMcmfHung("no termination after {$calls} progress calls (phase {$what})");
        }
    });
    try {
        $m->run();
        if ($m->infeasible) {
            $out["status"] = "infeasible";
        }
    } catch (PcsMcmfHung $ex) {
        $out["status"] = "hung";
        $out["message"] = $ex->getMessage();
    } catch (Throwable $ex) {
        $out["status"] = "error";
        $out["message"] = get_class($ex) . ": " . $ex->getMessage();
    }
    // Read the edge list (private) in insertion order; shuffle() is never called.
    $elist = Closure::bind(function () { return $this->e; }, $m, MinCostMaxFlow::class)();
    $net = array_fill(0, $n, 0);
    $index = array_flip($names);
    foreach ($elist as $e) {
        $out["flows"][] = $e->flow;
        if ($e->flow < $e->mincap || $e->flow > $e->cap) {
            $out["bounded"] = false;
        }
        $net[$index[$e->src->name]] -= $e->flow;
        $net[$index[$e->dst->name]] += $e->flow;
    }
    for ($i = 2; $i < $n; ++$i) {
        if ($net[$i] != 0) {
            $out["conserving"] = false;
        }
    }
    if ($out["status"] === "ok") {
        $out["maxflow"] = $m->current_flow();
        $out["cost"] = $m->current_cost();
        $out["precision_limited"] = $m->precision_limited;
    }
    echo json_encode($out), "\n";
    $m->clear();
}
