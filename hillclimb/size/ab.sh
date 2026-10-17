#!/usr/bin/env bash
# Both models through the whole app on the first 6 pages of the 52 documents (run from hillclimb/, serve.py and Chrome up).
set -u
../venv_train/bin/python size/corpus_e2e.py size/ab_student.jsonl --pages 6 --rows size/corpus_rows_student --models http://localhost:8080/hillclimb/size/hosted
../venv_train/bin/python size/corpus_e2e.py size/ab_teacher.jsonl --pages 6 --rows size/corpus_rows_teacher --models http://localhost:8080/hillclimb/size/hosted_teacher
