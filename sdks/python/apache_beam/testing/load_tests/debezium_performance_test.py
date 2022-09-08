#
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements.  See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License.  You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

"""
Performance test for debezium.

The purpose of this test is verify that Python's connector ReadFromDebezium
work propertly, for this, the test create a postgresql database inside a
kubernetes pod and stream querys inside of the database for 20 minutes.
After that ReadFromDebezium checks if everything goes well

Example test run:

python -m apache_beam.testing.load_tests.debezium_performance

or:

./gradlew
 -PloadTest.mainClass=apache_beam.testing.load_tests.debezium_performance \
-Prunner=DirectRunner :sdks:python:apache_beam:testing:load_tests:run
"""

import logging
import random
import time
from concurrent.futures import ThreadPoolExecutor

import psycopg2

from apache_beam import Pipeline
from apache_beam.io.debezium import DriverClassName
from apache_beam.io.debezium import ReadFromDebezium
from apache_beam.options.pipeline_options import PipelineOptions
from apache_beam.testing.load_tests.load_test import LoadTest

SECONDS_IN_MINUTE = 60
NUMBER_OF_OPERATIONS = SECONDS_IN_MINUTE * 20


class DebeziumLoadTest(LoadTest):
  def __init__(self):
    super().__init__()
    self.runner = self.pipeline.get_option('runner')
    self.kubernetes_host = self.pipeline.get_option('kubernetes_host')
    self.kubernetes_port = self.pipeline.get_option('kubernetes_port')
    self.postgres_user = self.pipeline.get_option('postgres_user')
    self.postgres_password = self.pipeline.get_option('postgres_password')

    self.username = self.postgres_user
    self.password = self.postgres_password

    self.database = 'postgres'
    self.port = self.kubernetes_port
    self.host = self.kubernetes_host
    self.connector_class = DriverClassName.POSTGRESQL
    self.connection_properties = [
        "database.dbname=postgres",
        "database.server.name=postgres",
        "database.include.list=postgres",
        "include.schema.changes=false",
        "plugin.name=pgoutput"
    ]
    self.pipeline_options = {
        'project': self.pipeline.get_option('project'),
        'job_name': self.pipeline.get_option('job_name'),
        'temp_location': self.pipeline.get_option('temp_location'),
        'region': self.pipeline.get_option('region')
    }

  def initConnection(self):
    connection = psycopg2.connect(
        host=self.host,
        database=self.database,
        user=self.username,
        password=self.password)
    return connection

  def randomInsertTest(self):
    connection = self.initConnection()
    insert = 0
    cursor = connection.cursor()
    createTable = """
            CREATE TABLE IF NOT EXISTS postgres(
                id NUMERIC,
                word VARCHAR(50),
                number NUMERIC,
                date DATE,
                bool BOOLEAN
            )
        """
    cursor.execute(createTable)
    alterTableReplica = "ALTER TABLE postgres REPLICA IDENTITY FULL;"
    cursor.execute(alterTableReplica)

    operations_number = NUMBER_OF_OPERATIONS
    # 60% inserts, 30% updates, 10% deletes
    operations_distribution = [('insert', 0.6), ('update', 0.3),
                               ('delete', 0.1)]

    logging.debug('INSERTING INTO POSTGRES')
    for operation, dist in operations_distribution:
      n = int(operations_number * dist)
      for _ in range(n):
        if operation == 'insert':
          number = random.randint(1, 1000)
          boolean = bool(random.getrandbits(1))
          insertQuery = """INSERT INTO postgres(id,word,number,date,bool)
                                      VALUES(%s,%s,%s,%s,%s);"""
          cursor.execute(
              insertQuery,
              (
                  str(insert),
                  "apacheBeam",
                  str(number),
                  "05/03/1999",
                  str(boolean)))
          insert += 1

        if operation == 'update':
          updateQuery = """UPDATE postgres
                                  SET word = 'apache'
                                  WHERE id IN (SELECT max(id) from postgres
                                  )"""
          cursor.execute(updateQuery)

        if operation == 'delete':
          deleteQuery = """DELETE FROM postgres
                                   WHERE id IN (
                                   SELECT id FROM
                                   postgres WHERE word='apacheBeam' LIMIT 1
                                   )"""
          cursor.execute(deleteQuery)

        time.sleep(1)

    connection.commit()
    cursor.close()

    logging.debug("FINISHED INSERTING")

  def createPipeline(self):
    #if the max_number_of_records is not defined the pipeline doesn't finish
    options = PipelineOptions.from_dictionary(self.pipeline_options)
    self.pipeline = Pipeline(options=options)
    self.pipeline.not_use_test_runner_api = True

    _ = (
        self.pipeline | 'Read from debezium' >> ReadFromDebezium(
            username=self.username,
            password=self.password,
            host=self.host,
            port=self.port,
            max_number_of_records=NUMBER_OF_OPERATIONS,
            connector_class=self.connector_class,
            connection_properties=self.connection_properties))

    logging.debug('RUNNING PIPELINE')
    self.pipeline.run().wait_until_finish()

    logging.debug("EXIT FROM PIPELINE")


if __name__ == '__main__':
  logging.basicConfig(level=logging.DEBUG)
  executor = ThreadPoolExecutor(max_workers=1)
  debeziumTest = DebeziumLoadTest()

  logging.debug("STARTING RANDOM INSERTS")
  executor.submit(debeziumTest.randomInsertTest)

  logging.debug("READING FROM DEBEZIUM")
  debeziumTest.createPipeline()
