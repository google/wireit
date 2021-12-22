export interface State {
  tasks: {[taskName: string]: TaskState};
}

export interface TaskState {
  cacheKey?: string;
}
