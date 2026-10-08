import { DepartmentSlugSchema } from '@superagent/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage, ProblemError } from '../../api/client';
import { useCreateDepartment } from '../../api/org';
import { slugify } from '../../lib/slug';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { FormFailure, Spinner } from '../../ui/feedback';
import { Field, Input, Textarea } from '../../ui/field';
import { Switch } from '../../ui/switch';
import { toast } from '../../ui/toast';

/** Sets up a department, then opens its team to add a lead. */
export function NewDepartmentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const create = useCreateDepartment();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [autoClose, setAutoClose] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; slug?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts fresh
  useEffect(() => {
    if (!open) return;
    setName('');
    setSlug('');
    setSlugEdited(false);
    setDescription('');
    setAutoClose(false);
    setErrors({});
    setFailure(null);
    create.reset();
  }, [open]);

  const shownSlug = slugEdited ? slug : slugify(name);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = {
      name: name.trim() ? undefined : 'Give it a name.',
      slug: DepartmentSlugSchema.safeParse(shownSlug).success
        ? undefined
        : 'Lowercase letters, digits and dashes, up to 40.',
    };
    setErrors(next);
    if (next.name || next.slug) return;
    setFailure(null);
    try {
      const department = await create.mutateAsync({
        name: name.trim(),
        slug: shownSlug,
        description: description.trim(),
        autoClose,
      });
      toast.success(`${department.name} is set up`, 'Add its lead next: it plans the work and reports back.');
      onOpenChange(false);
      navigate(`/departments/${encodeURIComponent(department.slug)}?tab=team`);
    } catch (error) {
      if (error instanceof ProblemError && error.code === 'department_slug_taken') {
        setErrors({ slug: 'Another department has this slug.' });
      } else {
        setFailure(errorMessage(error));
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New department"
      description="A department takes tasks for one area of your work. Its lead plans each task and hands parts to its specialists."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-department" variant="primary" disabled={create.isPending}>
            {create.isPending ? <Spinner /> : null}
            Create department
          </Button>
        </>
      }
    >
      <form id="new-department" onSubmit={submit} className="flex flex-col gap-4 pb-1" noValidate>
        {failure ? <FormFailure>{failure}</FormFailure> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors.name}>
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={100}
                placeholder="Research"
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field label="Slug" error={errors.slug} hint="In links. It can’t change later.">
            {(control) => (
              <Input
                {...control}
                value={shownSlug}
                maxLength={40}
                placeholder="research"
                className="font-mono"
                onChange={(event) => {
                  setSlugEdited(true);
                  setSlug(event.target.value.toLowerCase());
                }}
              />
            )}
          </Field>
        </div>
        <Field
          label="What it’s for"
          hint="Your chief of staff reads this to choose which department gets a task."
        >
          {(control) => (
            <Textarea
              {...control}
              value={description}
              maxLength={1000}
              rows={3}
              placeholder="Finds, reads and summarizes sources: papers, news, competitors."
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </Field>
        <Switch
          checked={autoClose}
          onCheckedChange={setAutoClose}
          label="Close finished tasks without my review"
          hint="Tasks close as soon as the lead reports, instead of waiting for you to accept them."
        />
      </form>
    </Dialog>
  );
}
