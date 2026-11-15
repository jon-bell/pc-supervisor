package net.jonbell.pcs.agent.engines

import java.nio.file.Path

object EngineFactory {
    /**
     * Builds the adapter for a configuration. Nothing here calls out or needs a credential: the live
     * adapters build their clients on first use. An API key is read only from the variable the
     * configuration names (`API_KEY_ENV`), so no key is read for an engine that does not name one.
     */
    fun create(cfg: EngineConfig, env: Map<String, String> = System.getenv()): Registered {
        val key = cfg.apiKeyEnv?.let { env[it] }
        val engine: Engine =
            when (cfg.adapter) {
                Adapter.REPLAY ->
                    ReplayEngine(
                        cfg.id,
                        FileResultStore(
                            Path.of(
                                requireNotNull(cfg.recordings) {
                                    "engine ${cfg.id}: replay needs RECORDINGS (a store directory)"
                                },
                            ),
                        ),
                    )
                Adapter.ANTHROPIC -> AnthropicEngine(cfg, key)
                Adapter.OPENAI_COMPAT -> OpenAiCompatEngine(cfg, key)
                Adapter.CLAUDE_CODE -> ClaudeCodeEngine(cfg)
            }
        return Registered(cfg, engine)
    }
}
