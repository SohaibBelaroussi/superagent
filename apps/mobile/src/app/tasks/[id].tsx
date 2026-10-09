import { useLocalSearchParams } from 'expo-router';
import { TaskScreen } from '../../features/tasks/task-screen';

export default function TaskRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <TaskScreen id={id} />;
}
