alter table public.products
drop constraint if exists products_coating_check;

alter table public.products
add constraint products_coating_check
check (
  coating in (
    'без покрытия', 'НФ', 'АФ', 'Ф', 'ФА', 'ФТ', 'ФТ-У',
    'AL', 'AL2', 'СТ', 'БТ', 'НГ арм.базальтом'
  )
);
