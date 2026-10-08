// The phase machine lives in @superagent/shared, so clients offer only the moves the API accepts.
export {
  BOARD_PHASES,
  canTransition,
  OPEN_PHASES,
  type PhaseActor,
  TERMINAL_PHASES,
} from '@superagent/shared/phases';
