<?php
// Differential-test driver for PLAN M14: runs HotCRP's MinCostMaxFlow on instances read from stdin.
//
//   docker compose -p "$HOTCRP_COMPOSE_PROJECT" -f hotcrp/compose.yaml exec -T hotcrp \
//       php /tmp/mcmf-driver.php [patched] < instances.json
//
// Input: a JSON list of {"n": nodes, "s": source, "t": sink, "arcs": [[from, to, lower, cap, cost], ...]}.
// Output: a JSON list of {"flow": value, "cost": cost, "infeasible": bool, "timeout": false} per instance,
// or {"timeout": true} when HotCRP does not finish within 1 s.
// Node s becomes HotCRP's ".source" and node t its ".sink"; the others are named "v<i>".
// HotCRP's own initialization, because MinCostMaxFlow::run() reads Conf::$main (a debug option)
require_once("/var/www/html/src/init.php");
initialize_conf();

// `php mcmf-driver.php patched` runs HotCRP's code with one fix. pushrelabel_make_distance() runs
// before the preflow and walks backward from the sink over residual arcs, so it reaches the source
// through its not-yet-saturated arcs and gives it a distance of a few hops instead of n. Excess then
// flows back to the source while augmenting paths longer than that still exist, and the "maximum"
// flow comes out too small (e.g. source -3-> a, a -1-> sink, a -2-> b -2-> c -2-> d -1-> sink gives 1, not 2).
// The fix keeps the source out of that search, so it stays at distance n.
if (($argv[1] ?? "") === "patched") {
    $src = file_get_contents("/var/www/html/lib/mincostmaxflow.php");
    $from = '&& $e->other($qhead)->xlink === $this->sink)';
    $to = '&& $e->other($qhead) !== $this->source && $e->other($qhead)->xlink === $this->sink)';
    assert(substr_count($src, $from) === 1);
    eval("?>" . str_replace($from, $to, $src));
}

$instances = json_decode(stream_get_contents(STDIN), true);
$out = [];
foreach ($instances as $inst) {
    $m = new MinCostMaxFlow;
    $name = function ($i) use ($inst) {
        return $i === $inst["s"] ? ".source" : ($i === $inst["t"] ? ".sink" : "v$i");
    };
    for ($i = 0; $i < $inst["n"]; ++$i) {
        if ($i !== $inst["s"] && $i !== $inst["t"]) {
            $m->add_node("v$i");
        }
    }
    foreach ($inst["arcs"] as $a) {
        $m->add_edge($name($a[0]), $name($a[1]), $a[3], $a[4], $a[2]);
    }
    // HotCRP's push-relabel can spin forever on some feasible instances with lower bounds; its
    // progress callback runs every 32768 steps, so use it as a watchdog
    $deadline = microtime(true) + 1;
    $m->add_progress_function(function () use ($deadline) {
        if (microtime(true) > $deadline) {
            throw new RuntimeException("timeout");
        }
    });
    try {
        $m->run();
    } catch (RuntimeException $e) {
        $out[] = ["timeout" => true];
        continue;
    }
    $out[] = [
        "flow" => $m->current_flow(),
        "cost" => $m->current_cost(),
        "infeasible" => (bool) $m->infeasible,
        "timeout" => false,
    ];
}
echo json_encode($out), "\n";
